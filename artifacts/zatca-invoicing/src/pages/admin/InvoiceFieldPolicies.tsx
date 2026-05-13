// /admin/invoice-field-policies  (SuperAdmin-only screen)
//
// Two-pane manager:
//   ① القوالب  — create/edit named policy profiles. Each profile is a full
//                bundle covering the 3 invoice scopes (Sales / Purchase / POS)
//                with a 4-mode select per field + today_only toggle for date
//                fields. AI button suggests a bundle for the chosen role.
//   ② تعيين المستخدمين — list every user in the company with a dropdown to
//                pick the profile that governs their invoice screens.

import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Loader2, Save, Sparkles, Eye, EyeOff, Lock, Asterisk,
  ShieldCheck, ArrowRight, Receipt, ShoppingCart, Store, Calendar,
  Plus, Trash2, Users, Star, StarOff, Pencil,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

// ── Types ────────────────────────────────────────────────────────────────
type FieldMode = "editable" | "readonly" | "hidden" | "required";
type DateConstraint = "none" | "today_only";
type PolicyScope = "sales" | "purchase" | "pos";
interface FieldRule { mode: FieldMode; dateConstraint?: DateConstraint }
type PolicyMap = Record<string, FieldRule>;
type PolicyBundle = Record<PolicyScope, PolicyMap>;
interface FieldDef { key: string; labelAr: string; labelEn: string; isDate?: boolean }
type Catalogue = Record<PolicyScope, FieldDef[]>;
interface Profile {
  id: number; name: string; bundle: PolicyBundle;
  isDefault: boolean; color: string | null; assignedCount: number; updatedAt: string;
}
interface AssignmentUser {
  id: number; username: string; email: string | null; role: string;
  nameAr: string | null; nameEn: string | null; profileId: number | null;
}

// ── Visual helpers ───────────────────────────────────────────────────────
const MODE_META: Record<FieldMode, { labelAr: string; tone: string; icon: any }> = {
  editable: { labelAr: "قابل للتعديل", tone: "bg-emerald-100 text-emerald-700 border-emerald-200",  icon: Eye },
  readonly: { labelAr: "للقراءة فقط",   tone: "bg-amber-100 text-amber-700 border-amber-200",       icon: Lock },
  hidden:   { labelAr: "مخفي",          tone: "bg-slate-200 text-slate-700 border-slate-300",       icon: EyeOff },
  required: { labelAr: "إلزامي",        tone: "bg-rose-100 text-rose-700 border-rose-200",          icon: Asterisk },
};
const PALETTE = [
  "#6366f1", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6",
  "#06b6d4", "#ec4899", "#14b8a6", "#f97316", "#0ea5e9",
];
function pickColor(seed: string | number): string {
  const s = String(seed);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
function userDisplayName(u: AssignmentUser): string {
  return u.nameAr ?? u.nameEn ?? u.username;
}
function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0] ?? "").join("").toUpperCase();
}

// ── API helpers ──────────────────────────────────────────────────────────
function authHeaders(): Record<string, string> {
  const tok = localStorage.getItem("zatca_token") ?? "";
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (tok) h.Authorization = `Bearer ${tok}`;
  return h;
}
async function jget<T>(path: string): Promise<T> {
  const r = await fetch(`${API}/api/invoice-field-policies${path}`, { headers: authHeaders() });
  if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? `HTTP ${r.status}`);
  return r.json();
}
async function jsend<T>(method: string, path: string, body?: any): Promise<T> {
  const r = await fetch(`${API}/api/invoice-field-policies${path}`, {
    method, headers: authHeaders(), body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? `HTTP ${r.status}`);
  return r.json();
}

// ────────────────────────────────────────────────────────────────────────
//                              Page
// ────────────────────────────────────────────────────────────────────────
export default function InvoiceFieldPoliciesPage() {
  const { user } = useAuth() as any;
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();

  // Hard guard: this page is SuperAdmin-only. Routing already gates this,
  // but a defensive client check keeps the screen clean if the route ever
  // shifts.
  useEffect(() => {
    if (user && user.role !== "superadmin") navigate("/");
  }, [user, navigate]);

  const [tab, setTab] = useState<"profiles" | "assignments">("profiles");
  const [editing, setEditing] = useState<Profile | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Profile | null>(null);

  const { data: catData } = useQuery<{ catalogue: Catalogue }>({
    queryKey: ["ifp", "catalogue"],
    queryFn: () => jget<{ catalogue: Catalogue }>("/catalogue"),
    staleTime: Infinity,
  });
  const catalogue = catData?.catalogue;

  const { data: profData, isLoading: profLoading } = useQuery<{ profiles: Profile[] }>({
    queryKey: ["ifp", "profiles"],
    queryFn: () => jget<{ profiles: Profile[] }>("/profiles"),
  });
  const profiles = profData?.profiles ?? [];

  const { data: asgnData, isLoading: asgnLoading } = useQuery<{ users: AssignmentUser[] }>({
    queryKey: ["ifp", "assignments"],
    queryFn: () => jget<{ users: AssignmentUser[] }>("/assignments"),
    enabled: tab === "assignments",
  });
  const users = asgnData?.users ?? [];

  // ── Profile mutations ──
  const setDefault = useMutation({
    mutationFn: (p: Profile) => jsend<{ profile: Profile }>("PUT", `/profiles/${p.id}`, { isDefault: !p.isDefault }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ifp", "profiles"] }),
  });
  const deleteProfile = useMutation({
    mutationFn: (p: Profile) => jsend<{ ok: true }>("DELETE", `/profiles/${p.id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ifp", "profiles"] });
      qc.invalidateQueries({ queryKey: ["ifp", "assignments"] });
      toast({ title: "تم الحذف" });
      setConfirmDelete(null);
    },
    onError: (e: any) => toast({ title: "تعذر الحذف", description: e?.message ?? "", variant: "destructive" }),
  });

  // ── Assignment mutation ──
  const assign = useMutation({
    mutationFn: ({ userId, profileId }: { userId: number; profileId: number | null }) =>
      jsend<{ ok: true }>("PUT", `/assignments/${userId}`, { profileId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ifp", "assignments"] }),
    onError: (e: any) => toast({ title: "تعذر الحفظ", description: e?.message ?? "", variant: "destructive" }),
  });

  return (
    <div className="space-y-6 p-6 bg-gradient-to-br from-slate-50 via-white to-indigo-50/30 min-h-screen">
      {/* ── Header ── */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="p-3 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 text-white shadow-lg">
            <ShieldCheck className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">حوكمة حقول الفواتير</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              قوالب صلاحيات يحددها السوبر أدمن — تعيّن لكل مستخدم القالب المناسب لدوره
            </p>
          </div>
        </div>
        <Button variant="outline" onClick={() => navigate("/")} className="gap-2">
          <ArrowRight className="w-4 h-4" /> رجوع
        </Button>
      </div>

      {/* ── Tabs ── */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as any)}>
        <TabsList className="grid w-full max-w-md grid-cols-2">
          <TabsTrigger value="profiles" className="gap-2">
            <ShieldCheck className="w-4 h-4" /> القوالب ({profiles.length})
          </TabsTrigger>
          <TabsTrigger value="assignments" className="gap-2">
            <Users className="w-4 h-4" /> تعيين المستخدمين
          </TabsTrigger>
        </TabsList>

        {/* ── Profiles tab ── */}
        <TabsContent value="profiles" className="mt-5 space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              أنشئ قوالب باسامي مفهومة (مثال: <span className="font-medium">"كاشير"</span>،
              <span className="font-medium"> "محاسب مبتدئ"</span>،
              <span className="font-medium"> "مدير فرع"</span>) ثم عيّنها للمستخدمين من التبويب التالي.
            </p>
            <Button onClick={() => setCreating(true)} className="gap-2">
              <Plus className="w-4 h-4" /> قالب جديد
            </Button>
          </div>

          {profLoading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          ) : profiles.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="py-12 flex flex-col items-center gap-3 text-center">
                <ShieldCheck className="w-10 h-10 text-muted-foreground" />
                <div>
                  <p className="font-medium">لا توجد قوالب بعد</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    ابدأ بإنشاء قالب — مثلاً "كاشير" — لتحديد ما يظهر للمستخدم على شاشات الفواتير.
                  </p>
                </div>
                <Button onClick={() => setCreating(true)} className="gap-2 mt-2">
                  <Plus className="w-4 h-4" /> أنشئ أول قالب
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {profiles.map((p) => {
                const color = p.color ?? pickColor(p.id);
                return (
                  <Card key={p.id} className="overflow-hidden hover:shadow-md transition-shadow">
                    <div className="h-2" style={{ background: color }} />
                    <CardHeader className="pb-3">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <CardTitle className="text-lg flex items-center gap-2">
                            {p.name}
                            {p.isDefault && (
                              <Badge className="bg-amber-100 text-amber-700 border-amber-200 gap-1">
                                <Star className="w-3 h-3" /> افتراضي
                              </Badge>
                            )}
                          </CardTitle>
                          <CardDescription className="mt-1 flex items-center gap-1.5">
                            <Users className="w-3.5 h-3.5" />
                            {p.assignedCount} مستخدم
                          </CardDescription>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="flex flex-wrap gap-1.5 text-[11px]">
                        {(["sales", "purchase", "pos"] as PolicyScope[]).map((sc) => {
                          const counts = countModes(p.bundle[sc] ?? {});
                          return (
                            <Badge key={sc} variant="outline" className="gap-1">
                              {sc === "sales" ? "مبيعات" : sc === "purchase" ? "مشتريات" : "POS"}
                              {counts.hidden ? <span className="text-slate-500">·{counts.hidden}🚫</span> : null}
                              {counts.readonly ? <span className="text-amber-600">·{counts.readonly}🔒</span> : null}
                              {counts.required ? <span className="text-rose-600">·{counts.required}⚠</span> : null}
                            </Badge>
                          );
                        })}
                      </div>
                      <div className="flex items-center gap-2 pt-1">
                        <Button size="sm" variant="default" className="gap-1.5 flex-1" onClick={() => setEditing(p)}>
                          <Pencil className="w-3.5 h-3.5" /> تعديل
                        </Button>
                        <Button size="sm" variant="outline" className="gap-1.5"
                          onClick={() => setDefault.mutate(p)} disabled={setDefault.isPending}>
                          {p.isDefault
                            ? <><StarOff className="w-3.5 h-3.5" /> إلغاء افتراضي</>
                            : <><Star className="w-3.5 h-3.5" /> اجعله افتراضي</>}
                        </Button>
                        <Button size="sm" variant="ghost" className="text-rose-600 hover:bg-rose-50"
                          onClick={() => setConfirmDelete(p)}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>

        {/* ── Assignments tab ── */}
        <TabsContent value="assignments" className="mt-5 space-y-3">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Users className="w-4 h-4" /> مستخدمو الشركة
              </CardTitle>
              <CardDescription>
                اختر القالب المناسب لكل مستخدم. المستخدمون بدون قالب يحصلون على القالب الافتراضي تلقائياً.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {asgnLoading ? (
                <div className="flex items-center justify-center py-8 text-muted-foreground">
                  <Loader2 className="w-5 h-5 animate-spin" />
                </div>
              ) : users.length === 0 ? (
                <p className="text-sm text-muted-foreground py-6 text-center">لا يوجد مستخدمون.</p>
              ) : (
                <div className="divide-y">
                  {users.map((u) => {
                    const isAdminUser = u.role === "admin" || u.role === "superadmin";
                    const assignedProfile = profiles.find((p) => p.id === u.profileId);
                    return (
                      <div key={u.id} className="flex items-center gap-3 py-3">
                        <Avatar className="w-9 h-9">
                          <AvatarFallback
                            style={{ background: pickColor(u.id), color: "white" }}
                            className="text-xs font-semibold"
                          >
                            {initials(userDisplayName(u))}
                          </AvatarFallback>
                        </Avatar>
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-sm flex items-center gap-2 truncate">
                            {userDisplayName(u)}
                            {isAdminUser && (
                              <Badge variant="outline" className="text-[10px] gap-1">
                                <ShieldCheck className="w-3 h-3" />
                                {u.role === "superadmin" ? "سوبر أدمن" : "مدير"}
                              </Badge>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground truncate">
                            {u.email ?? u.username}
                          </div>
                        </div>
                        <div className="w-56">
                          {isAdminUser ? (
                            <span className="text-xs text-muted-foreground italic">
                              المديرون يتجاوزون الحوكمة
                            </span>
                          ) : (
                            <Select
                              value={u.profileId == null ? "_default" : String(u.profileId)}
                              onValueChange={(v) => assign.mutate({
                                userId: u.id,
                                profileId: v === "_default" ? null : Number(v),
                              })}
                            >
                              <SelectTrigger className="h-9">
                                {assignedProfile ? (
                                  <span className="flex items-center gap-2">
                                    <span className="w-2 h-2 rounded-full"
                                      style={{ background: assignedProfile.color ?? pickColor(assignedProfile.id) }} />
                                    {assignedProfile.name}
                                  </span>
                                ) : (
                                  <SelectValue placeholder="القالب الافتراضي" />
                                )}
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="_default">
                                  <span className="text-muted-foreground">القالب الافتراضي</span>
                                </SelectItem>
                                {profiles.map((p) => (
                                  <SelectItem key={p.id} value={String(p.id)}>
                                    <span className="flex items-center gap-2">
                                      <span className="w-2 h-2 rounded-full"
                                        style={{ background: p.color ?? pickColor(p.id) }} />
                                      {p.name}
                                      {p.isDefault && <Star className="w-3 h-3 text-amber-500" />}
                                    </span>
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* ── Editor Dialog ── */}
      {(editing || creating) && catalogue && (
        <ProfileEditorDialog
          mode={creating ? "create" : "edit"}
          initial={editing}
          catalogue={catalogue}
          onClose={() => { setEditing(null); setCreating(false); }}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["ifp", "profiles"] });
            qc.invalidateQueries({ queryKey: ["ifp", "assignments"] });
            setEditing(null); setCreating(false);
          }}
        />
      )}

      {/* ── Delete confirm ── */}
      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>حذف القالب "{confirmDelete?.name}"؟</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDelete?.assignedCount
                ? `سيتم إلغاء تعيين ${confirmDelete.assignedCount} مستخدم وسيرجعون للقالب الافتراضي.`
                : "لن يتأثر أي مستخدم."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 hover:bg-rose-700"
              onClick={() => confirmDelete && deleteProfile.mutate(confirmDelete)}
            >
              حذف
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function countModes(map: PolicyMap): Record<FieldMode, number> {
  const c: Record<FieldMode, number> = { editable: 0, readonly: 0, hidden: 0, required: 0 };
  for (const r of Object.values(map)) c[r.mode] = (c[r.mode] ?? 0) + 1;
  return c;
}

// ── Editor Dialog ────────────────────────────────────────────────────────
function ProfileEditorDialog({
  mode, initial, catalogue, onClose, onSaved,
}: {
  mode: "create" | "edit";
  initial: Profile | null;
  catalogue: Catalogue;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [name, setName] = useState(initial?.name ?? "");
  const [color, setColor] = useState<string>(initial?.color ?? PALETTE[0]);
  const [bundle, setBundle] = useState<PolicyBundle>(
    initial?.bundle ?? emptyBundle(catalogue),
  );
  const [tab, setTab] = useState<PolicyScope>("sales");
  const [aiBusy, setAiBusy] = useState(false);

  const setRule = (sc: PolicyScope, key: string, patch: Partial<FieldRule>) => {
    setBundle((b) => ({
      ...b,
      [sc]: { ...b[sc], [key]: { ...(b[sc][key] ?? { mode: "editable" }), ...patch } },
    }));
  };

  async function aiSuggest() {
    if (!name.trim()) {
      toast({ title: "اكتب اسم القالب أولاً", variant: "destructive" });
      return;
    }
    setAiBusy(true);
    try {
      const r = await jsend<{ source: string; bundle: PolicyBundle }>("POST", "/suggest", { role: name });
      setBundle(r.bundle);
      toast({
        title: r.source === "ai" ? "اقتراح ذكي جاهز" : "تم تطبيق اقتراح افتراضي",
        description: r.source === "ai" ? "تمت قراءة نشاط الشركة." : "الذكاء الاصطناعي غير مفعل — استخدمنا قالب جاهز.",
      });
    } catch (e: any) {
      toast({ title: "تعذر الاقتراح", description: e?.message ?? "", variant: "destructive" });
    } finally {
      setAiBusy(false);
    }
  }

  const save = useMutation({
    mutationFn: () => {
      if (mode === "create") {
        return jsend<{ profile: Profile }>("POST", "/profiles", { name, color, bundle });
      }
      return jsend<{ profile: Profile }>("PUT", `/profiles/${initial!.id}`, { name, color, bundle });
    },
    onSuccess: () => { toast({ title: "تم الحفظ" }); onSaved(); },
    onError: (e: any) => toast({ title: "تعذر الحفظ", description: e?.message ?? "", variant: "destructive" }),
  });

  const SCOPE_META = {
    sales:    { icon: Receipt,      label: "المبيعات" },
    purchase: { icon: ShoppingCart, label: "المشتريات" },
    pos:      { icon: Store,        label: "نقاط البيع" },
  } as const;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-indigo-600" />
            {mode === "create" ? "قالب جديد" : `تعديل: ${initial?.name}`}
          </DialogTitle>
          <DialogDescription>
            عرّف لكل حقل: قابل للتعديل، للقراءة فقط، مخفي، أو إلزامي. لحقل التاريخ يمكنك قفله على اليوم الحالي.
          </DialogDescription>
        </DialogHeader>

        {/* Name + color + AI */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
          <div className="md:col-span-5 space-y-1.5">
            <Label className="text-xs">اسم القالب</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="مثال: كاشير، محاسب مبتدئ، مدير فرع" />
          </div>
          <div className="md:col-span-4 space-y-1.5">
            <Label className="text-xs">اللون</Label>
            <div className="flex flex-wrap gap-1.5">
              {PALETTE.map((c) => (
                <button key={c} type="button" onClick={() => setColor(c)}
                  className={`w-7 h-7 rounded-full border-2 transition ${color === c ? "border-slate-900 scale-110" : "border-transparent"}`}
                  style={{ background: c }} aria-label={c} />
              ))}
            </div>
          </div>
          <div className="md:col-span-3">
            <Button variant="outline" className="w-full gap-2" onClick={aiSuggest} disabled={aiBusy}>
              {aiBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
              اقتراح ذكي
            </Button>
          </div>
        </div>

        {/* Scope tabs */}
        <Tabs value={tab} onValueChange={(v) => setTab(v as PolicyScope)} className="mt-2">
          <TabsList className="grid w-full grid-cols-3">
            {(["sales", "purchase", "pos"] as PolicyScope[]).map((sc) => {
              const M = SCOPE_META[sc]; const Ic = M.icon;
              return (
                <TabsTrigger key={sc} value={sc} className="gap-2">
                  <Ic className="w-4 h-4" /> {M.label}
                </TabsTrigger>
              );
            })}
          </TabsList>

          {(["sales", "purchase", "pos"] as PolicyScope[]).map((sc) => (
            <TabsContent key={sc} value={sc} className="mt-3 space-y-2">
              {catalogue[sc].map((f) => {
                const r = bundle[sc]?.[f.key] ?? { mode: "editable" as FieldMode };
                const meta = MODE_META[r.mode];
                const Ic = meta.icon;
                return (
                  <div key={f.key} className="flex items-center gap-3 p-2.5 rounded-lg border bg-white">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{f.labelAr}</div>
                      <div className="text-[11px] text-muted-foreground truncate">{f.labelEn} · <code>{f.key}</code></div>
                    </div>
                    <Badge className={`gap-1 ${meta.tone}`}>
                      <Ic className="w-3 h-3" /> {meta.labelAr}
                    </Badge>
                    <Select value={r.mode} onValueChange={(v) => setRule(sc, f.key, { mode: v as FieldMode })}>
                      <SelectTrigger className="w-40 h-8"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {(["editable", "readonly", "hidden", "required"] as FieldMode[]).map((m) => (
                          <SelectItem key={m} value={m}>{MODE_META[m].labelAr}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {f.isDate && (
                      <div className="flex items-center gap-1.5 text-xs">
                        <Calendar className="w-3.5 h-3.5 text-muted-foreground" />
                        اليوم فقط
                        <Switch
                          checked={r.dateConstraint === "today_only"}
                          onCheckedChange={(c) => setRule(sc, f.key, { dateConstraint: c ? "today_only" : "none" })}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </TabsContent>
          ))}
        </Tabs>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>إلغاء</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || !name.trim()} className="gap-2">
            {save.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            حفظ
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function emptyBundle(cat: Catalogue): PolicyBundle {
  const out: PolicyBundle = { sales: {}, purchase: {}, pos: {} };
  for (const sc of ["sales", "purchase", "pos"] as PolicyScope[]) {
    for (const f of cat[sc]) {
      out[sc][f.key] = { mode: "editable", ...(f.isDate ? { dateConstraint: "none" as const } : {}) };
    }
  }
  return out;
}
