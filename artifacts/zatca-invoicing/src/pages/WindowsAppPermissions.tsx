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
  Loader2, MonitorSmartphone, Search, Building2, ShieldCheck, CheckCircle2,
  XCircle, Save, RotateCcw, Sparkles, ShoppingCart, Users, Warehouse,
  ShoppingBag, FileText, Wallet, BookOpen, Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

// ─── Windows desktop-app module definitions ────────────────────────────
// DUPLICATED, by design, from artifacts/pos-desktop/src/lib/moduleRegistry.ts
// (the two artifacts cannot import from each other — same convention as
// COMPANY_MODULE_GATE). Keep WINDOWS_MODULES here in lockstep with that file.
// Each key maps to a coarse module the SuperAdmin can show/hide on the company's
// Windows install; the flags are pushed to the device through /api/sync/pull.
interface WinModule { key: string; label: string; icon: React.ElementType; hint: string; }

const WINDOWS_MODULES: WinModule[] = [
  { key: "pos",        label: "نقطة البيع (بيع / مرتجع / يومية)", icon: ShoppingCart, hint: "شاشة الكاشير الأساسية — يُنصح بإبقائها مفعّلة دائمًا" },
  { key: "customers",  label: "العملاء",                          icon: Users,        hint: "إدارة العملاء على الجهاز" },
  { key: "inventory",  label: "المخازن والأصناف",                 icon: Warehouse,    hint: "الأصناف، الوحدات، الجرد، التحويلات، تقارير المخزون" },
  { key: "purchasing", label: "المشتريات والموردون",              icon: ShoppingBag,  hint: "الموردون، فواتير ومرتجعات الشراء" },
  { key: "sales_docs", label: "فواتير المبيعات (الخلفية)",        icon: FileText,     hint: "فواتير ومرتجعات المبيعات خارج شاشة الكاشير" },
  { key: "cash_banks", label: "النقد والبنوك",                    icon: Wallet,       hint: "الخزن، البنوك، المعاملات المالية، العملات وأسعار الصرف" },
  { key: "accounting", label: "الحسابات والتقارير المالية",       icon: BookOpen,     hint: "شجرة الحسابات، القيود، مراكز التكلفة، الضرائب، التقارير" },
  { key: "control",    label: "التحكم والإعدادات",                icon: Settings,     hint: "الفروع، المستخدمون، الصلاحيات، أرقام المسلسلات، الإعدادات" },
];

const DEFAULT_PERMISSIONS: Record<string, boolean> = WINDOWS_MODULES.reduce(
  (acc, m) => { acc[m.key] = true; return acc; },
  {} as Record<string, boolean>,
);

function parsePerms(raw: string | null | undefined): Record<string, boolean> {
  try { return { ...DEFAULT_PERMISSIONS, ...JSON.parse(raw ?? "{}") }; }
  catch { return { ...DEFAULT_PERMISSIONS }; }
}

// ─── Page ──────────────────────────────────────────────────────────────
export default function WindowsAppPermissions() {
  const { token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draft, setDraft] = useState<Record<string, boolean> | null>(null);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token ?? ""}`,
    "Content-Type": "application/json",
  };

  const { data: companies = [], isLoading } = useQuery<any[]>({
    queryKey: ["companies-windows-perms"],
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
    () => (selected ? parsePerms(selected.windowsModulePermissions) : { ...DEFAULT_PERMISSIONS }),
    [selected],
  );

  useEffect(() => {
    setDraft(selected ? parsePerms(selected.windowsModulePermissions) : null);
  }, [selectedId, selected?.windowsModulePermissions]);

  const isDirty = useMemo(() => {
    if (!draft) return false;
    return WINDOWS_MODULES.some(m => Boolean(draft[m.key]) !== Boolean(savedPerms[m.key]));
  }, [draft, savedPerms]);

  const saveMutation = useMutation({
    mutationFn: async ({ companyId, perms }: { companyId: number; perms: Record<string, boolean> }) => {
      const res = await fetch(`${API}/api/companies/${companyId}/windows-module-permissions`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ windowsModulePermissions: JSON.stringify(perms) }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "فشل الحفظ");
      return json;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["companies-windows-perms"] });
      toast({ title: "تم حفظ صلاحيات تطبيق الويندوز بنجاح" });
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

  const toggle = (key: string) =>
    setDraft(d => (d ? { ...d, [key]: !d[key] } : d));
  const setAll = (val: boolean) =>
    setDraft(d => (d ? Object.fromEntries(WINDOWS_MODULES.map(m => [m.key, val])) : d));
  const reset = () => setDraft(savedPerms);
  const copyFrom = (sourceId: number) => {
    const src = companies.find((c: any) => c.id === sourceId);
    if (src) setDraft(parsePerms(src.windowsModulePermissions));
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
          <div className="p-2.5 rounded-xl bg-gradient-to-br from-sky-500 to-blue-600 text-white shadow-md">
            <MonitorSmartphone className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold">صلاحيات تطبيق الويندوز</h1>
            <p className="text-sm text-muted-foreground">
              تحكّم في الوحدات الظاهرة على تطبيق سطح المكتب (الكاشير) لكل شركة. تُدفع التغييرات للجهاز عند المزامنة.
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
                const perms = parsePerms(c.windowsModulePermissions);
                const enabled = WINDOWS_MODULES.filter(m => perms[m.key]).length;
                const total = WINDOWS_MODULES.length;
                const isSel = c.id === selectedId;
                return (
                  <button
                    key={c.id}
                    onClick={() => setSelectedId(c.id)}
                    className={cn(
                      "w-full text-right p-2.5 rounded-lg border transition-all",
                      isSel
                        ? "bg-gradient-to-l from-sky-50 to-blue-50 border-sky-300 shadow-sm dark:from-sky-950/40 dark:to-blue-950/40"
                        : "bg-card hover:bg-muted/50 border-transparent",
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className={cn("font-medium text-sm truncate", isSel && "text-sky-700 dark:text-sky-400")}>
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
              <Card className="sticky top-0 z-10 border-2 border-sky-200 dark:border-sky-900 shadow-md">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="p-2.5 rounded-xl bg-gradient-to-br from-sky-500 to-blue-600 text-white">
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
                        className="gap-1 h-8 bg-gradient-to-l from-sky-600 to-blue-600 hover:from-sky-700 hover:to-blue-700"
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
                      لديك تغييرات غير محفوظة — اضغط "حفظ التغييرات" لتطبيقها (تظهر على الجهاز بعد المزامنة)
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Modules grid */}
              {draft && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {WINDOWS_MODULES.map(m => {
                    const on = !!draft[m.key];
                    return (
                      <label
                        key={m.key}
                        className={cn(
                          "flex items-center justify-between gap-3 px-4 py-3 rounded-xl border cursor-pointer transition",
                          on ? "bg-card hover:bg-muted/30 border-sky-200" : "bg-muted/20 hover:bg-muted/40 border-transparent",
                        )}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div className={cn(
                            "p-2 rounded-lg transition shrink-0",
                            on ? "bg-sky-50 text-sky-700" : "bg-muted text-muted-foreground",
                          )}>
                            <m.icon className="h-4 w-4" />
                          </div>
                          <div className="min-w-0">
                            <span className={cn("text-sm font-semibold block truncate", !on && "text-muted-foreground")}>
                              {m.label}
                            </span>
                            <span className="text-[11px] text-muted-foreground block truncate">{m.hint}</span>
                          </div>
                        </div>
                        <Switch checked={on} onCheckedChange={() => toggle(m.key)} />
                      </label>
                    );
                  })}
                </div>
              )}

              <p className="text-xs text-muted-foreground text-center py-2">
                <Sparkles className="h-3 w-3 inline ml-1" />
                تنطبق هذه الإعدادات على تطبيق سطح المكتب فقط؛ وضع "نقطة بيع فقط" على الجهاز يُخفي وحدات الإدارة بغضّ النظر عن هذه المفاتيح.
              </p>
            </div>
          )}

        </div>
      )}
    </div>
  );
}
