import { useState, useMemo, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Loader2, LayoutDashboard, FileText, Users, Truck, Link2, Search, Building2,
  ShieldCheck, BarChart3, Warehouse, ShoppingCart, ShoppingBag, Wallet, BookOpen,
  PieChart, Smartphone, CheckCircle2, XCircle, Save, Copy, RotateCcw, Sparkles,
  ChevronDown, ChevronUp, UserCog, HardHat, Factory, ShieldAlert, TrendingUp,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { MENU_ITEMS as MENU_ITEMS_BASE, SECTIONS } from "@/lib/menuItems";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

// ─── Menu definitions ──────────────────────────────────────────────────
// Source of truth for the key/label/section trio is `lib/menuItems.ts`
// (shared with /admin/industries and /register so the three pages stay
// perfectly in sync). Icons live here because they're a presentation
// concern owned by this page only — adding a new sidebar entry means
// editing the lib AND adding a row in MENU_ICONS.
interface MenuItem { key: string; label: string; icon: React.ElementType; section: string; }

const MENU_ICONS: Record<string, React.ElementType> = {
  dashboard:          LayoutDashboard,
  invoices:           FileText,
  customers:          Users,
  suppliers:          Truck,
  reports:            BarChart3,
  inventory_mobile:   Smartphone,
  inventory_reports:  Warehouse,
  sales_module:       ShoppingCart,
  sales_reports:      PieChart,
  purchases_module:   ShoppingBag,
  purchases_reports:  PieChart,
  pos:                ShoppingCart,
  cash_module:        Wallet,
  cash_reports:       PieChart,
  accounts:           BookOpen,
  accounting_reports: PieChart,
  hr_module:          UserCog,
  contracting:        HardHat,
  production:         Factory,
  security_events:    ShieldAlert,
  seo_dashboard:      TrendingUp,
  ai_tools:           Sparkles,
  zatca:              Link2,
};

const MENU_ITEMS: MenuItem[] = MENU_ITEMS_BASE.map(m => ({
  ...m,
  icon: MENU_ICONS[m.key] ?? LayoutDashboard,
}));

const SECTION_THEME: Record<string, { bg: string; text: string; border: string; ring: string }> = {
  "رئيسي":     { bg: "bg-blue-50",    text: "text-blue-700",    border: "border-blue-200",    ring: "from-blue-500/10" },
  "الأعمال":    { bg: "bg-emerald-50", text: "text-emerald-700", border: "border-emerald-200", ring: "from-emerald-500/10" },
  "المخازن":    { bg: "bg-amber-50",   text: "text-amber-700",   border: "border-amber-200",   ring: "from-amber-500/10" },
  "المبيعات":   { bg: "bg-cyan-50",    text: "text-cyan-700",    border: "border-cyan-200",    ring: "from-cyan-500/10" },
  "المشتريات":  { bg: "bg-orange-50",  text: "text-orange-700",  border: "border-orange-200",  ring: "from-orange-500/10" },
  "نقاط البيع": { bg: "bg-teal-50",    text: "text-teal-700",    border: "border-teal-200",    ring: "from-teal-500/10" },
  "المحاسبة":   { bg: "bg-indigo-50",  text: "text-indigo-700",  border: "border-indigo-200",  ring: "from-indigo-500/10" },
  "شؤون الموظفين": { bg: "bg-rose-50",   text: "text-rose-700",    border: "border-rose-200",    ring: "from-rose-500/10" },
  "تحليلات SEO": { bg: "bg-fuchsia-50", text: "text-fuchsia-700", border: "border-fuchsia-200", ring: "from-fuchsia-500/10" },
  "أدوات الذكاء الاصطناعي": { bg: "bg-violet-50", text: "text-violet-700", border: "border-violet-200", ring: "from-violet-500/10" },
  "النظام":     { bg: "bg-purple-50",  text: "text-purple-700",  border: "border-purple-200",  ring: "from-purple-500/10" },
};

const DEFAULT_PERMISSIONS: Record<string, boolean> = MENU_ITEMS.reduce(
  (acc, m) => { acc[m.key] = true; return acc; },
  {} as Record<string, boolean>,
);

function parsePerms(raw: string | null | undefined): Record<string, boolean> {
  try { return { ...DEFAULT_PERMISSIONS, ...JSON.parse(raw ?? "{}") }; }
  catch { return { ...DEFAULT_PERMISSIONS }; }
}

// ─── Page ──────────────────────────────────────────────────────────────
export default function MenuPermissions() {
  const { token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draft, setDraft] = useState<Record<string, boolean> | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token ?? ""}`,
    "Content-Type": "application/json",
  };

  const { data: companies = [], isLoading } = useQuery<any[]>({
    queryKey: ["companies-menu-perms"],
    queryFn: async () => {
      const res = await fetch(`${API}/api/companies`, { headers });
      if (!res.ok) throw new Error("فشل تحميل الشركات");
      return res.json();
    },
  });

  // Auto-select first company
  useEffect(() => {
    if (selectedId == null && companies.length > 0) setSelectedId(companies[0].id);
  }, [companies, selectedId]);

  const selected = useMemo(
    () => companies.find((c: any) => c.id === selectedId) ?? null,
    [companies, selectedId],
  );

  const savedPerms = useMemo(
    () => (selected ? parsePerms(selected.menuPermissions) : { ...DEFAULT_PERMISSIONS }),
    [selected],
  );

  // Load draft when selection changes
  useEffect(() => {
    setDraft(selected ? parsePerms(selected.menuPermissions) : null);
  }, [selectedId, selected?.menuPermissions]);

  const isDirty = useMemo(() => {
    if (!draft) return false;
    return MENU_ITEMS.some(m => Boolean(draft[m.key]) !== Boolean(savedPerms[m.key]));
  }, [draft, savedPerms]);

  const saveMutation = useMutation({
    mutationFn: async ({ companyId, perms }: { companyId: number; perms: Record<string, boolean> }) => {
      const res = await fetch(`${API}/api/companies/${companyId}/menu-permissions`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ menuPermissions: JSON.stringify(perms) }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "فشل الحفظ");
      return json;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["companies-menu-perms"] });
      toast({ title: "تم حفظ الصلاحيات بنجاح" });
    },
    onError: (e: any) => toast({ title: "فشل الحفظ: " + e.message, variant: "destructive" }),
  });

  const filteredCompanies = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return companies;
    return companies.filter((c: any) =>
      c.nameAr?.toLowerCase().includes(s) ||
      c.nameEn?.toLowerCase().includes(s) ||
      c.vatNumber?.includes(s),
    );
  }, [companies, search]);

  // ─── Helpers ─────────────────────────────────────────────────────
  const toggle = (key: string) =>
    setDraft(d => (d ? { ...d, [key]: !d[key] } : d));

  const setSection = (section: string, val: boolean) =>
    setDraft(d => {
      if (!d) return d;
      const next = { ...d };
      MENU_ITEMS.filter(m => m.section === section).forEach(m => { next[m.key] = val; });
      return next;
    });

  const setAll = (val: boolean) =>
    setDraft(d => (d ? Object.fromEntries(MENU_ITEMS.map(m => [m.key, val])) : d));

  const reset = () => setDraft(savedPerms);

  const copyFrom = (sourceId: number) => {
    const src = companies.find((c: any) => c.id === sourceId);
    if (src) setDraft(parsePerms(src.menuPermissions));
  };

  const save = () => {
    if (!selected || !draft) return;
    saveMutation.mutate({ companyId: selected.id, perms: draft });
  };

  return (
    <div className="space-y-5" dir="rtl">

      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 text-white shadow-md">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold">صلاحيات القوائم</h1>
            <p className="text-sm text-muted-foreground">
              اختر شركة من القائمة، ثم فعّل أو عطّل القوائم بسهولة. التغييرات تُحفظ بضغطة واحدة.
            </p>
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-5">

          {/* ─── Companies sidebar ───────────────────────────── */}
          <Card className="h-fit lg:sticky lg:top-4 max-h-[calc(100vh-6rem)] overflow-hidden flex flex-col">
            <div className="p-3 border-b bg-muted/30">
              <div className="relative mb-2">
                <Search className="absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="ابحث عن شركة..."
                  className="h-8 pr-8 text-sm"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                <Building2 className="h-3 w-3 inline ml-1" />
                {filteredCompanies.length} شركة
              </p>
            </div>
            <div className="overflow-y-auto flex-1 p-2 space-y-1">
              {filteredCompanies.map((c: any) => {
                const perms = parsePerms(c.menuPermissions);
                const enabled = MENU_ITEMS.filter(m => perms[m.key]).length;
                const total = MENU_ITEMS.length;
                const isSel = c.id === selectedId;
                return (
                  <button
                    key={c.id}
                    onClick={() => setSelectedId(c.id)}
                    className={cn(
                      "w-full text-right p-2.5 rounded-lg border transition-all",
                      isSel
                        ? "bg-gradient-to-l from-indigo-50 to-purple-50 border-indigo-300 shadow-sm dark:from-indigo-950/40 dark:to-purple-950/40"
                        : "bg-card hover:bg-muted/50 border-transparent",
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className={cn("font-medium text-sm truncate", isSel && "text-indigo-700 dark:text-indigo-400")}>
                          {c.nameAr}
                        </p>
                        <p className="text-[11px] font-mono text-muted-foreground truncate" dir="ltr">
                          {c.vatNumber}
                        </p>
                      </div>
                      <Badge
                        variant="outline"
                        className={cn(
                          "shrink-0 text-[10px] h-5 px-1.5",
                          enabled === total
                            ? "bg-emerald-50 text-emerald-700 border-emerald-300"
                            : enabled === 0
                            ? "bg-red-50 text-red-700 border-red-300"
                            : "bg-amber-50 text-amber-700 border-amber-300",
                        )}
                      >
                        {enabled}/{total}
                      </Badge>
                    </div>
                  </button>
                );
              })}
              {filteredCompanies.length === 0 && (
                <div className="text-center text-sm text-muted-foreground py-8">
                  لا توجد نتائج
                </div>
              )}
            </div>
          </Card>

          {/* ─── Editor panel ───────────────────────────────── */}
          {!selected ? (
            <Card><CardContent className="py-20 text-center text-muted-foreground">
              <ShieldCheck className="h-12 w-12 mx-auto mb-3 opacity-30" />
              اختر شركة من القائمة للبدء
            </CardContent></Card>
          ) : (
            <div className="space-y-4">

              {/* Selected company sticky header */}
              <Card className="sticky top-0 z-10 border-2 border-indigo-200 dark:border-indigo-900 shadow-md">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="p-2.5 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 text-white">
                        <Building2 className="h-5 w-5" />
                      </div>
                      <div className="min-w-0">
                        <h2 className="font-bold text-lg truncate">{selected.nameAr}</h2>
                        <p className="text-xs text-muted-foreground font-mono" dir="ltr">
                          الرقم الضريبي: {selected.vatNumber}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <Button size="sm" variant="outline" onClick={() => setAll(true)} className="gap-1 h-8">
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> تفعيل الكل
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setAll(false)} className="gap-1 h-8">
                        <XCircle className="h-3.5 w-3.5 text-red-600" /> تعطيل الكل
                      </Button>
                      <select
                        onChange={(e) => { if (e.target.value) { copyFrom(Number(e.target.value)); e.target.value = ""; } }}
                        defaultValue=""
                        className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                        title="نسخ من شركة أخرى"
                      >
                        <option value="">📋 نسخ من شركة...</option>
                        {companies.filter((c: any) => c.id !== selected.id).map((c: any) => (
                          <option key={c.id} value={c.id}>{c.nameAr}</option>
                        ))}
                      </select>
                      {isDirty && (
                        <Button size="sm" variant="outline" onClick={reset} className="gap-1 h-8">
                          <RotateCcw className="h-3.5 w-3.5" /> تراجع
                        </Button>
                      )}
                      <Button
                        size="sm"
                        onClick={save}
                        disabled={!isDirty || saveMutation.isPending}
                        className="gap-1 h-8 bg-gradient-to-l from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700"
                      >
                        {saveMutation.isPending ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Save className="h-3.5 w-3.5" />
                        )}
                        {isDirty ? "حفظ التغييرات" : "محفوظ"}
                      </Button>
                    </div>
                  </div>
                  {isDirty && (
                    <div className="mt-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-1.5 flex items-center gap-2">
                      <Sparkles className="h-3.5 w-3.5" />
                      لديك تغييرات غير محفوظة — اضغط "حفظ التغييرات" لتطبيقها
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Sections grid */}
              {draft && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {SECTIONS.map(section => {
                    const items = MENU_ITEMS.filter(m => m.section === section);
                    const enabledIn = items.filter(m => draft[m.key]).length;
                    const allOn  = enabledIn === items.length;
                    const allOff = enabledIn === 0;
                    const theme = SECTION_THEME[section] ?? SECTION_THEME["رئيسي"];
                    const isCollapsed = collapsed[section];

                    return (
                      <Card key={section} className={cn("overflow-hidden border", theme.border)}>
                        {/* Section header */}
                        <div className={cn("px-4 py-3 border-b flex items-center justify-between", theme.bg)}>
                          <button
                            onClick={() => setCollapsed(c => ({ ...c, [section]: !c[section] }))}
                            className="flex items-center gap-2"
                          >
                            {isCollapsed ? (
                              <ChevronDown className={cn("h-4 w-4", theme.text)} />
                            ) : (
                              <ChevronUp className={cn("h-4 w-4", theme.text)} />
                            )}
                            <span className={cn("font-bold text-sm", theme.text)}>{section}</span>
                            <Badge variant="outline" className={cn("text-[10px] h-5", theme.text, theme.border, "bg-white/60")}>
                              {enabledIn}/{items.length}
                            </Badge>
                          </button>
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-muted-foreground">تفعيل القسم</span>
                            <Switch
                              checked={allOn}
                              onCheckedChange={(v) => setSection(section, v)}
                              className={cn(allOff ? "" : "")}
                            />
                          </div>
                        </div>

                        {/* Items */}
                        {!isCollapsed && (
                          <div className="divide-y">
                            {items.map(m => {
                              const on = !!draft[m.key];
                              return (
                                <label
                                  key={m.key}
                                  className={cn(
                                    "flex items-center justify-between gap-3 px-4 py-2.5 cursor-pointer transition",
                                    on ? "bg-card hover:bg-muted/30" : "bg-muted/20 hover:bg-muted/40",
                                  )}
                                >
                                  <div className="flex items-center gap-3 min-w-0">
                                    <div className={cn(
                                      "p-1.5 rounded-md transition",
                                      on ? cn(theme.bg, theme.text) : "bg-muted text-muted-foreground",
                                    )}>
                                      <m.icon className="h-4 w-4" />
                                    </div>
                                    <span className={cn("text-sm font-medium truncate", !on && "text-muted-foreground")}>
                                      {m.label}
                                    </span>
                                  </div>
                                  <Switch checked={on} onCheckedChange={() => toggle(m.key)} />
                                </label>
                              );
                            })}
                          </div>
                        )}
                      </Card>
                    );
                  })}
                </div>
              )}

              {/* Footer note */}
              <p className="text-xs text-muted-foreground text-center py-2">
                <Sparkles className="h-3 w-3 inline ml-1" />
                نصيحة: استخدم "نسخ من شركة" لتطبيق نفس الإعدادات على شركة جديدة بسرعة
              </p>
            </div>
          )}

        </div>
      )}
    </div>
  );
}
