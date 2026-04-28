import { useMemo, useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Briefcase, Pencil, Trash2, Plus, RefreshCw, Search, Sparkles, Power, Check,
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

// One row from /api/admin/industries
type IndustryRow = {
  id: number;
  code: string;
  nameAr: string;
  nameEn: string;
  emoji: string;
  recommendedModuleKeys: string[];
  sortOrder: number;
  isActive: boolean;
};

// One row from /api/admin/modules — we only need a small subset to render
// the multi-select picker inside the edit dialog.
type ModuleOption = {
  id: number;
  key: string;
  nameAr: string;
  category: string;
  isActive: boolean;
};

type FormState = Omit<IndustryRow, "id"> & { id?: number };

const EMPTY_FORM: FormState = {
  code: "",
  nameAr: "",
  nameEn: "",
  emoji: "🏢",
  recommendedModuleKeys: [],
  sortOrder: 0,
  isActive: true,
};

// Curated emoji options for the picker. Plain unicode keeps the UI free
// of extra icon imports and renders identically on every device.
const EMOJI_OPTIONS = [
  "🛒", "🏭", "🏗️", "🩺", "🏨", "🍽️", "🚚", "🏥", "🏦", "🏫",
  "💼", "🏢", "📦", "🛠️", "💻", "🚗", "✈️", "⛽", "🍞", "💊",
];

export default function Industries() {
  const { token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<FormState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<IndustryRow | null>(null);

  // Live data: industries list + modules list (for the multi-select picker)
  const listQ = useQuery<IndustryRow[]>({
    queryKey: ["admin-industries"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/industries`, { headers });
      if (!r.ok) throw new Error((await r.json()).error || "فشل جلب الأنشطة");
      return r.json();
    },
  });

  const modulesQ = useQuery<ModuleOption[]>({
    queryKey: ["admin-modules", "for-industries"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/modules`, { headers });
      if (!r.ok) throw new Error((await r.json()).error || "فشل جلب الوحدات");
      return r.json();
    },
  });

  const filtered = useMemo(() => {
    const list = listQ.data ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter(i =>
      i.nameAr.toLowerCase().includes(q) ||
      i.nameEn.toLowerCase().includes(q) ||
      i.code.toLowerCase().includes(q)
    );
  }, [listQ.data, search]);

  // For looking up module names by key in the read-only badge list shown
  // on each industry card. Falls back to the raw key if the module was
  // deleted from the catalog after the industry referenced it.
  const moduleByKey = useMemo(() => {
    const m = new Map<string, ModuleOption>();
    for (const mod of modulesQ.data ?? []) m.set(mod.key, mod);
    return m;
  }, [modulesQ.data]);

  const saveMut = useMutation({
    mutationFn: async (form: FormState) => {
      const isUpdate = typeof form.id === "number";
      const url = isUpdate ? `${API}/api/admin/industries/${form.id}` : `${API}/api/admin/industries`;
      const r = await fetch(url, {
        method: isUpdate ? "PUT" : "POST",
        headers,
        body: JSON.stringify(form),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "فشل الحفظ");
      return data;
    },
    onSuccess: () => {
      toast({ title: "تم الحفظ" });
      setEditing(null);
      qc.invalidateQueries({ queryKey: ["admin-industries"] });
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const toggleMut = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/admin/industries/${id}/toggle`, { method: "PATCH", headers });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "فشل التبديل");
      return d;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-industries"] }),
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/admin/industries/${id}`, { method: "DELETE", headers });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "فشل الحذف");
      return d;
    },
    onSuccess: () => {
      toast({ title: "تم الحذف" });
      setConfirmDelete(null);
      qc.invalidateQueries({ queryKey: ["admin-industries"] });
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const seedMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/admin/industries/seed`, { method: "POST", headers });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "فشل التهيئة");
      return d;
    },
    onSuccess: (d: any) => {
      toast({
        title: "اكتمل تحميل الأنشطة الافتراضية",
        description: `أُضيف ${d.inserted} • تم تجاوز ${d.skipped}`,
      });
      qc.invalidateQueries({ queryKey: ["admin-industries"] });
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  // Helpers used inside the edit dialog
  const toggleModuleInForm = (key: string) => {
    if (!editing) return;
    const has = editing.recommendedModuleKeys.includes(key);
    setEditing({
      ...editing,
      recommendedModuleKeys: has
        ? editing.recommendedModuleKeys.filter(k => k !== key)
        : [...editing.recommendedModuleKeys, key],
    });
  };

  return (
    <div className="space-y-6 p-4 md:p-6" dir="rtl">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Briefcase className="text-primary" /> أنواع الأنشطة (الباقات الافتراضية)
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            تُعرض هذه الأنشطة كـ <span className="font-medium">شرائح اختيار</span> في صفحة إنشاء الحساب،
            وعند اختيار أي نشاط تُضاف وحداته الموصى بها تلقائياً لاختيار العميل.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => listQ.refetch()} disabled={listQ.isFetching}>
            <RefreshCw className={`h-4 w-4 ml-2 ${listQ.isFetching ? "animate-spin" : ""}`} />
            تحديث
          </Button>
          {(listQ.data?.length ?? 0) === 0 && (
            <Button variant="secondary" onClick={() => seedMut.mutate()} disabled={seedMut.isPending}>
              <Sparkles className="h-4 w-4 ml-2" />
              تحميل الأنشطة الافتراضية
            </Button>
          )}
          <Button onClick={() => setEditing({ ...EMPTY_FORM })}>
            <Plus className="h-4 w-4 ml-2" />
            إضافة نشاط
          </Button>
        </div>
      </div>

      <div className="relative max-w-md">
        <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          dir="rtl" className="pr-9"
          placeholder="بحث بالاسم أو المُعرّف…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {listQ.isLoading ? (
        <div className="text-center text-muted-foreground py-12">جاري التحميل…</div>
      ) : (listQ.data?.length ?? 0) === 0 ? (
        <Card>
          <CardContent className="py-16 text-center space-y-3">
            <Briefcase className="h-12 w-12 mx-auto text-muted-foreground/50" />
            <div className="text-lg font-medium">لا توجد أنشطة بعد</div>
            <div className="text-sm text-muted-foreground">
              ابدأ بتحميل الأنشطة الافتراضية أو أضف نشاطاً يدوياً.
            </div>
          </CardContent>
        </Card>
      ) : filtered.length === 0 ? (
        <div className="text-center text-muted-foreground py-12">لا نتائج مطابقة للبحث.</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {filtered.map(ind => (
            <Card key={ind.id} className={`relative transition ${ind.isActive ? "" : "opacity-60"}`}>
              <CardContent className="p-4 space-y-3">
                <div className="flex items-start gap-3">
                  <div className="text-3xl leading-none w-12 h-12 rounded-lg bg-primary/5 flex items-center justify-center">
                    {ind.emoji}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className="font-semibold truncate">{ind.nameAr}</div>
                      {!ind.isActive && <Badge variant="outline" className="text-[10px]">مُعطَّل</Badge>}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">{ind.code}</div>
                  </div>
                  <div className="text-left">
                    <div className="text-xs text-muted-foreground">ترتيب</div>
                    <div className="font-bold text-sm">{ind.sortOrder}</div>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <div className="text-[11px] text-muted-foreground">الوحدات الموصى بها ({ind.recommendedModuleKeys.length}):</div>
                  <div className="flex flex-wrap gap-1">
                    {ind.recommendedModuleKeys.length === 0 ? (
                      <span className="text-xs text-muted-foreground italic">لم يُضَف أي وحدة بعد</span>
                    ) : ind.recommendedModuleKeys.map(k => {
                      const mod = moduleByKey.get(k);
                      const label = mod?.nameAr ?? k;
                      const dim = !mod || !mod.isActive;
                      return (
                        <Badge
                          key={k}
                          variant={dim ? "outline" : "secondary"}
                          className={`text-[10px] ${dim ? "text-muted-foreground line-through" : ""}`}
                          title={dim ? "الوحدة غير موجودة أو مُعطَّلة" : k}
                        >
                          {label}
                        </Badge>
                      );
                    })}
                  </div>
                </div>

                <div className="flex items-center justify-between gap-2 pt-2 border-t">
                  <div className="flex items-center gap-2 text-xs">
                    <Switch
                      checked={ind.isActive}
                      onCheckedChange={() => toggleMut.mutate(ind.id)}
                      disabled={toggleMut.isPending}
                    />
                    <Power className="h-3.5 w-3.5" />
                    {ind.isActive ? "مفعّل" : "متوقف"}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setEditing({ ...ind })}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button size="sm" variant="ghost"
                      className="text-destructive hover:text-destructive"
                      onClick={() => setConfirmDelete(ind)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Add / edit dialog */}
      <IndustryEditDialog
        editing={editing}
        setEditing={setEditing}
        modules={modulesQ.data ?? []}
        toggleModuleInForm={toggleModuleInForm}
        saveMut={saveMut}
      />

      {/* Delete confirm */}
      <AlertDialog open={confirmDelete !== null} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>حذف النشاط</AlertDialogTitle>
            <AlertDialogDescription>
              هل تريد حذف النشاط <span className="font-bold">{confirmDelete?.nameAr}</span>؟
              لا يمكن التراجع عن هذا الإجراء.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => confirmDelete && deleteMut.mutate(confirmDelete.id)}
            >
              حذف
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Edit dialog factored out to keep the page component readable. Receives
// the live modules list so the multi-select chips reflect the current
// catalogue (added or deactivated modules show up immediately).
// ─────────────────────────────────────────────────────────────────────
function IndustryEditDialog({
  editing, setEditing, modules, toggleModuleInForm, saveMut,
}: {
  editing: FormState | null;
  setEditing: (s: FormState | null) => void;
  modules: ModuleOption[];
  toggleModuleInForm: (key: string) => void;
  saveMut: ReturnType<typeof useMutation<any, any, FormState, any>>;
}) {
  // Group modules by category for the picker, mirroring the registration
  // wizard's grouping so admins see them in the same shape end-users do.
  const groups = useMemo(() => {
    const map = new Map<string, ModuleOption[]>();
    for (const m of modules) {
      const cat = m.category || "بدون تصنيف";
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(m);
    }
    return Array.from(map.entries());
  }, [modules]);

  // Reset scroll on open so a long picker list always starts at the top.
  useEffect(() => {
    if (editing) {
      const el = document.getElementById("ind-modules-picker");
      if (el) el.scrollTop = 0;
    }
  }, [editing?.id]);

  return (
    <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto" dir="rtl">
        <DialogHeader>
          <DialogTitle>{editing?.id ? "تعديل نشاط" : "إضافة نشاط جديد"}</DialogTitle>
          <DialogDescription>
            النشاط يربط شريحة الاختيار في صفحة التسجيل بمجموعة افتراضية من وحدات النظام.
          </DialogDescription>
        </DialogHeader>

        {editing && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>المُعرّف (code) *</Label>
              <Input
                dir="ltr" placeholder="commercial"
                value={editing.code}
                onChange={(e) => setEditing({ ...editing, code: e.target.value })}
              />
              <div className="text-[10px] text-muted-foreground">
                أحرف إنجليزية صغيرة وأرقام و _ فقط.
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>ترتيب العرض</Label>
              <Input
                type="number"
                value={editing.sortOrder}
                onChange={(e) => setEditing({ ...editing, sortOrder: Number(e.target.value) || 0 })}
              />
            </div>

            <div className="space-y-1.5">
              <Label>الاسم بالعربي *</Label>
              <Input
                value={editing.nameAr}
                onChange={(e) => setEditing({ ...editing, nameAr: e.target.value })}
              />
            </div>

            <div className="space-y-1.5">
              <Label>الاسم بالإنجليزي</Label>
              <Input
                dir="ltr"
                value={editing.nameEn}
                onChange={(e) => setEditing({ ...editing, nameEn: e.target.value })}
              />
            </div>

            <div className="space-y-1.5 md:col-span-2">
              <Label>الرمز التعبيري (Emoji)</Label>
              <div className="flex items-center gap-3">
                <div className="text-3xl w-14 h-14 flex items-center justify-center bg-primary/5 rounded-lg">
                  {editing.emoji}
                </div>
                <Input
                  className="w-24 text-2xl text-center"
                  value={editing.emoji}
                  onChange={(e) => setEditing({ ...editing, emoji: e.target.value })}
                />
                <div className="flex-1 grid grid-cols-10 gap-1">
                  {EMOJI_OPTIONS.map(em => (
                    <button
                      type="button"
                      key={em}
                      onClick={() => setEditing({ ...editing, emoji: em })}
                      className={`text-xl p-1 rounded hover:bg-muted transition ${
                        editing.emoji === em ? "ring-2 ring-primary bg-primary/10" : ""
                      }`}
                    >
                      {em}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="space-y-1.5 md:col-span-2">
              <Label>
                الوحدات الموصى بها
                <span className="text-xs text-muted-foreground mr-2 font-normal">
                  (محدّد {editing.recommendedModuleKeys.length} من {modules.length})
                </span>
              </Label>
              <div
                id="ind-modules-picker"
                className="border rounded-lg p-3 max-h-72 overflow-y-auto space-y-3"
              >
                {modules.length === 0 ? (
                  <div className="text-xs text-muted-foreground text-center py-4">
                    لا توجد وحدات في النظام بعد. أضف وحدات من «وحدات النظام» أولاً.
                  </div>
                ) : groups.map(([cat, mods]) => (
                  <div key={cat}>
                    <div className="text-[11px] font-semibold text-muted-foreground mb-1.5 px-1">
                      {cat}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {mods.map(m => {
                        const checked = editing.recommendedModuleKeys.includes(m.key);
                        const dim = !m.isActive;
                        return (
                          <button
                            type="button"
                            key={m.key}
                            onClick={() => toggleModuleInForm(m.key)}
                            className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs border-2 transition ${
                              checked
                                ? "border-primary bg-primary/10 text-primary font-medium"
                                : "border-border bg-card text-muted-foreground hover:border-primary/40"
                            } ${dim ? "opacity-60" : ""}`}
                            title={dim ? "الوحدة مُعطَّلة" : m.key}
                          >
                            {checked && <Check className="h-3 w-3" />}
                            {m.nameAr}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
              <div className="text-[10px] text-muted-foreground">
                عند اختيار العميل لهذا النشاط في صفحة التسجيل ستُضاف الوحدات أعلاه تلقائياً لاختياره.
              </div>
            </div>

            <div className="md:col-span-2 flex items-center gap-3 pt-2 border-t">
              <Switch
                checked={editing.isActive}
                onCheckedChange={(v) => setEditing({ ...editing, isActive: v })}
              />
              <Label className="cursor-pointer" onClick={() => setEditing({ ...editing, isActive: !editing.isActive })}>
                {editing.isActive ? "مفعّل — يظهر في صفحة إنشاء الحساب" : "متوقف — مخفي عن العملاء"}
              </Label>
            </div>
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => setEditing(null)}>إلغاء</Button>
          <Button
            onClick={() => editing && saveMut.mutate(editing)}
            disabled={saveMut.isPending}
          >
            {saveMut.isPending ? "جارٍ الحفظ…" : "حفظ"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
