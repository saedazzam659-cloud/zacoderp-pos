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
  Loader2, Search, Building2, ShieldCheck, CheckCircle2, XCircle, Save, RotateCcw,
  Sparkles, ChevronDown, ChevronLeft, FileBarChart, LayoutGrid, Layers,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  MENU_ITEMS, MENU_ITEM_BY_KEY, MODULE_GROUPS, screenKey,
} from "@/lib/menuItems";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

// ─────────────────────────────────────────────────────────────────────
// Per-company menu permissions editor (SuperAdmin)
//
// TWO layers, both persisted into companies.menuPermissions JSON:
//   1. Module-level coarse keys (sales_module, pos, …) — the on/off master
//      switch for an entire module. These already existed.
//   2. Per-SCREEN keys `nav:<path>` — refine which individual screens show
//      inside an enabled module. ABSENT ⇒ visible (default-on); we only
//      persist the OFF ones (pruneForSave) so the JSON stays lean and
//      existing tenants keep all screens.
//
// The module catalog + screen lists come from MODULE_GROUPS in
// lib/menuItems.ts — the SAME source that drives /register and the
// SuperAdmin add-company picker.
// ─────────────────────────────────────────────────────────────────────

// Coarse module keys NOT represented by a MODULE_GROUP card. Kept as a
// simple toggle list ("وحدات أخرى") so nothing regresses.
const GROUPED_MODULE_KEYS = new Set(MODULE_GROUPS.flatMap(g => g.moduleKeys));
const EXTRA_KEYS = MENU_ITEMS.map(m => m.key).filter(k => !GROUPED_MODULE_KEYS.has(k));

// Modules LOCKED by default — absent ⇒ OFF (must be explicitly enabled by a
// SuperAdmin). Keep in sync with MODULE_GATE_DEFAULT_OFF in companyModuleGate.ts
// and permissions.ts (backend).
const DEFAULT_OFF_KEYS = new Set<string>(["office"]);

const DEFAULT_PERMISSIONS: Record<string, boolean> = MENU_ITEMS.reduce(
  (acc, m) => { acc[m.key] = !DEFAULT_OFF_KEYS.has(m.key); return acc; },
  {} as Record<string, boolean>,
);

function parsePerms(raw: string | null | undefined): Record<string, boolean> {
  try { return { ...DEFAULT_PERMISSIONS, ...JSON.parse(raw ?? "{}") }; }
  catch { return { ...DEFAULT_PERMISSIONS }; }
}

// Drop default-on nav:* keys (true) — only persist explicit OFFs. Coarse
// module keys are kept verbatim.
function pruneForSave(perms: Record<string, boolean>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(perms)) {
    if (k.startsWith("nav:")) { if (v === false) out[k] = false; }
    else out[k] = v;
  }
  return out;
}
function canon(perms: Record<string, boolean>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(pruneForSave(perms)).sort()));
}

// ─── Page ──────────────────────────────────────────────────────────────
export default function MenuPermissions() {
  const { token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draft, setDraft] = useState<Record<string, boolean> | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

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

  useEffect(() => {
    setDraft(selected ? parsePerms(selected.menuPermissions) : null);
  }, [selectedId, selected?.menuPermissions]);

  const isDirty = useMemo(() => {
    if (!draft) return false;
    return canon(draft) !== canon(savedPerms);
  }, [draft, savedPerms]);

  const saveMutation = useMutation({
    mutationFn: async ({ companyId, perms }: { companyId: number; perms: Record<string, boolean> }) => {
      const res = await fetch(`${API}/api/companies/${companyId}/menu-permissions`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ menuPermissions: JSON.stringify(pruneForSave(perms)) }),
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

  // ─── Mutators ────────────────────────────────────────────────────
  const setModule = (moduleKeys: string[], val: boolean) =>
    setDraft(d => {
      if (!d) return d;
      const next = { ...d };
      moduleKeys.forEach(k => { next[k] = val; });
      return next;
    });

  const setGroupScreens = (paths: string[], val: boolean) =>
    setDraft(d => {
      if (!d) return d;
      const next = { ...d };
      paths.forEach(p => { next[screenKey(p)] = val; });
      return next;
    });

  const toggleScreen = (path: string, cur: boolean) =>
    setDraft(d => (d ? { ...d, [screenKey(path)]: !cur } : d));

  const toggleExtra = (key: string) =>
    setDraft(d => (d ? { ...d, [key]: !d[key] } : d));

  const setAll = (val: boolean) =>
    setDraft(d => {
      if (!d) return d;
      const next = { ...d };
      MENU_ITEMS.forEach(m => { next[m.key] = val; });
      MODULE_GROUPS.forEach(g => g.screens.forEach(s => { next[screenKey(s.path)] = val; }));
      return next;
    });

  const reset = () => setDraft(savedPerms);

  const copyFrom = (sourceId: number) => {
    const src = companies.find((c: any) => c.id === sourceId);
    if (src) setDraft(parsePerms(src.menuPermissions));
  };

  const save = () => {
    if (!selected || !draft) return;
    saveMutation.mutate({ companyId: selected.id, perms: draft });
  };

  // Helpers reading current draft state
  const screenOn = (d: Record<string, boolean>, path: string) => d[screenKey(path)] !== false;
  const moduleOn = (d: Record<string, boolean>, moduleKeys: string[]) => moduleKeys.every(k => d[k] !== false);

  return (
    <div className="space-y-5" dir="rtl">

      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 text-white shadow-md">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold">صلاحيات القوائم والشاشات</h1>
            <p className="text-sm text-muted-foreground">
              فعّل أو عطّل الوحدات، ثم وسّع أي وحدة للتحكم في عرض كل شاشة وتقرير على حدة. التغييرات تُحفظ بضغطة واحدة.
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

              {/* Module cards with expandable per-screen toggles */}
              {draft && (
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
                  {MODULE_GROUPS.map(group => {
                    const modOn = moduleOn(draft, group.moduleKeys);
                    const screens = group.screens;
                    const screensOn = screens.filter(s => screenOn(draft, s.path)).length;
                    const isOpen = !!expanded[group.key];
                    const normalScreens = screens.filter(s => !s.report);
                    const reportScreens = screens.filter(s => s.report);

                    return (
                      <Card key={group.key} className={cn("overflow-hidden border", modOn ? "border-indigo-200 dark:border-indigo-900" : "border-muted")}>
                        {/* Module header */}
                        <div className={cn(
                          "px-4 py-3 border-b flex items-center justify-between gap-2",
                          modOn ? "bg-gradient-to-l from-indigo-50 to-purple-50 dark:from-indigo-950/30 dark:to-purple-950/30" : "bg-muted/40",
                        )}>
                          <button
                            onClick={() => setExpanded(e => ({ ...e, [group.key]: !e[group.key] }))}
                            className="flex items-center gap-2 min-w-0"
                          >
                            {isOpen
                              ? <ChevronDown className="h-4 w-4 text-indigo-600 shrink-0" />
                              : <ChevronLeft className="h-4 w-4 text-muted-foreground shrink-0" />}
                            <span className="text-lg leading-none">{group.emoji}</span>
                            <span className={cn("font-bold text-sm truncate", !modOn && "text-muted-foreground")}>
                              {group.label}
                            </span>
                            <Badge variant="outline" className="shrink-0 text-[10px] h-5 bg-white/70 dark:bg-black/20">
                              {screensOn}/{screens.length}
                            </Badge>
                          </button>
                          <div className="flex items-center gap-2 shrink-0">
                            <span className="text-xs text-muted-foreground hidden sm:inline">تفعيل الوحدة</span>
                            <Switch checked={modOn} onCheckedChange={(v) => setModule(group.moduleKeys, v)} />
                          </div>
                        </div>

                        {/* Expandable per-screen body */}
                        {isOpen && (
                          <div className={cn("p-3 space-y-3", !modOn && "opacity-60")}>
                            {!modOn && (
                              <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                                الوحدة معطّلة — لن تظهر شاشاتها حتى تُفعّلها. يمكنك ضبط الشاشات مسبقاً.
                              </p>
                            )}

                            {/* per-module quick actions */}
                            <div className="flex items-center justify-between gap-2 text-xs">
                              <span className="text-muted-foreground flex items-center gap-1">
                                <LayoutGrid className="h-3.5 w-3.5" /> {screens.length} شاشة
                              </span>
                              <div className="flex items-center gap-1.5">
                                <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]"
                                  onClick={() => setGroupScreens(screens.map(s => s.path), true)}>
                                  تحديد الكل
                                </Button>
                                <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]"
                                  onClick={() => setGroupScreens(screens.map(s => s.path), false)}>
                                  إلغاء الكل
                                </Button>
                              </div>
                            </div>

                            {/* Screens */}
                            <div>
                              <p className="text-[11px] font-semibold text-muted-foreground mb-1 flex items-center gap-1">
                                <Layers className="h-3.5 w-3.5" /> الشاشات
                              </p>
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3">
                                {normalScreens.map(s => {
                                  const on = screenOn(draft, s.path);
                                  return (
                                    <label key={s.path}
                                      className="flex items-center justify-between gap-2 py-1.5 cursor-pointer border-b border-dashed border-muted/60">
                                      <span className={cn("text-xs truncate", !on && "text-muted-foreground line-through")}>
                                        {s.label}
                                      </span>
                                      <Switch checked={on} onCheckedChange={() => toggleScreen(s.path, on)} />
                                    </label>
                                  );
                                })}
                              </div>
                            </div>

                            {/* Reports */}
                            {reportScreens.length > 0 && (
                              <div>
                                <p className="text-[11px] font-semibold text-muted-foreground mb-1 flex items-center gap-1">
                                  <FileBarChart className="h-3.5 w-3.5" /> التقارير
                                </p>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3">
                                  {reportScreens.map(s => {
                                    const on = screenOn(draft, s.path);
                                    return (
                                      <label key={s.path}
                                        className="flex items-center justify-between gap-2 py-1.5 cursor-pointer border-b border-dashed border-muted/60">
                                        <span className={cn("text-xs truncate", !on && "text-muted-foreground line-through")}>
                                          {s.label}
                                        </span>
                                        <Switch checked={on} onCheckedChange={() => toggleScreen(s.path, on)} />
                                      </label>
                                    );
                                  })}
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </Card>
                    );
                  })}
                </div>
              )}

              {/* Other coarse-only modules */}
              {draft && EXTRA_KEYS.length > 0 && (
                <Card className="overflow-hidden border">
                  <div className="px-4 py-3 border-b bg-muted/40 flex items-center gap-2">
                    <Layers className="h-4 w-4 text-muted-foreground" />
                    <span className="font-bold text-sm">وحدات أخرى</span>
                    <span className="text-xs text-muted-foreground">(تفعيل/تعطيل عام)</span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4">
                    {EXTRA_KEYS.map(k => {
                      const on = !!draft[k];
                      const label = MENU_ITEM_BY_KEY[k]?.label ?? k;
                      return (
                        <label key={k}
                          className="flex items-center justify-between gap-2 px-4 py-2.5 cursor-pointer border-b border-dashed border-muted/60">
                          <span className={cn("text-sm truncate", !on && "text-muted-foreground")}>{label}</span>
                          <Switch checked={on} onCheckedChange={() => toggleExtra(k)} />
                        </label>
                      );
                    })}
                  </div>
                </Card>
              )}

              {/* Footer note */}
              <p className="text-xs text-muted-foreground text-center py-2">
                <Sparkles className="h-3 w-3 inline ml-1" />
                نصيحة: وسّع أي وحدة للتحكم في عرض شاشة أو تقرير بعينه — الشاشات المفعّلة افتراضياً تظهر دائماً ما لم تُعطّلها.
              </p>
            </div>
          )}

        </div>
      )}
    </div>
  );
}
