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
  CheckSquare, Square,
} from "lucide-react";
import {
  MENU_ITEMS, SECTIONS, MENU_ITEM_BY_KEY, SECTION_THEME,
} from "@/lib/menuItems";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

// One row from /api/admin/industries. `recommendedModuleKeys` now stores
// granular menu-permission keys (matching MENU_ITEMS in lib/menuItems.ts)
// rather than the legacy high-level module keys. The column name was
// kept for migration compatibility — semantically it is now a list of
// menu permission keys that get auto-granted at registration.
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

  const listQ = useQuery<IndustryRow[]>({
    queryKey: ["admin-industries"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/industries`, { headers });
      if (!r.ok) throw new Error((await r.json()).error || "فشل جلب الأنشطة");
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
  const toggleMenuKeyInForm = (key: string) => {
    if (!editing) return;
    const has = editing.recommendedModuleKeys.includes(key);
    setEditing({
      ...editing,
      recommendedModuleKeys: has
        ? editing.recommendedModuleKeys.filter(k => k !== key)
        : [...editing.recommendedModuleKeys, key],
    });
  };

  // "Toggle entire section" — picks all keys in a section if any are
  // unselected; clears all of them if every key in the section is on.
  const toggleSectionInForm = (section: string) => {
    if (!editing) return;
    const keysInSection = MENU_ITEMS.filter(m => m.section === section).map(m => m.key);
    const allOn = keysInSection.every(k => editing.recommendedModuleKeys.includes(k));
    setEditing({
      ...editing,
      recommendedModuleKeys: allOn
        ? editing.recommendedModuleKeys.filter(k => !keysInSection.includes(k))
        : Array.from(new Set([...editing.recommendedModuleKeys, ...keysInSection])),
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
            وعند اختيار أي نشاط تُفعَّل صلاحيات القوائم المختارة هنا تلقائياً.
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
                  <div className="text-[11px] text-muted-foreground">
                    صلاحيات القوائم المُفعَّلة ({ind.recommendedModuleKeys.length}):
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {ind.recommendedModuleKeys.length === 0 ? (
                      <span className="text-xs text-muted-foreground italic">لم تُحدَّد أي صلاحية بعد</span>
                    ) : ind.recommendedModuleKeys.map(k => {
                      const item = MENU_ITEM_BY_KEY[k];
                      const label = item?.label ?? k;
                      const dim = !item;
                      const theme = item ? SECTION_THEME[item.section] : undefined;
                      return (
                        <Badge
                          key={k}
                          variant={dim ? "outline" : "secondary"}
                          className={`text-[10px] ${dim ? "text-muted-foreground line-through" : ""} ${theme ? `${theme.bg} ${theme.text} ${theme.border}` : ""}`}
                          title={dim ? "مفتاح غير معروف — راجع تعديل القوائم" : k}
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
        toggleMenuKeyInForm={toggleMenuKeyInForm}
        toggleSectionInForm={toggleSectionInForm}
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
// Edit dialog factored out to keep the page component readable. The
// menu-permission picker lives entirely on the client (MENU_ITEMS is
// a static catalog) — no server fetch is needed.
// ─────────────────────────────────────────────────────────────────────
function IndustryEditDialog({
  editing, setEditing, toggleMenuKeyInForm, toggleSectionInForm, saveMut,
}: {
  editing: FormState | null;
  setEditing: (s: FormState | null) => void;
  toggleMenuKeyInForm: (key: string) => void;
  toggleSectionInForm: (section: string) => void;
  saveMut: ReturnType<typeof useMutation<any, any, FormState, any>>;
}) {
  // Local search inside the picker — filters items by Arabic label, key,
  // or section name. Reset on open so each new edit starts fresh.
  const [pickerSearch, setPickerSearch] = useState("");
  useEffect(() => { if (editing) setPickerSearch(""); }, [editing?.id, editing?.code]);

  // Group items by section, applying the picker's search filter. Keep
  // empty sections collapsed (filtered out) so the list stays compact
  // when the operator types something narrow like "تقارير".
  const filteredGroups = useMemo(() => {
    const q = pickerSearch.trim().toLowerCase();
    return SECTIONS.map(section => {
      const items = MENU_ITEMS.filter(m => m.section === section).filter(m =>
        !q
          ? true
          : m.label.toLowerCase().includes(q) ||
            m.key.toLowerCase().includes(q) ||
            m.section.toLowerCase().includes(q)
      );
      return { section, items };
    }).filter(g => g.items.length > 0);
  }, [pickerSearch]);

  // Reset scroll on open so a long picker list always starts at the top.
  useEffect(() => {
    if (editing) {
      const el = document.getElementById("ind-perms-picker");
      if (el) el.scrollTop = 0;
    }
  }, [editing?.id]);

  return (
    <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto" dir="rtl">
        <DialogHeader>
          <DialogTitle>{editing?.id ? "تعديل نشاط" : "إضافة نشاط جديد"}</DialogTitle>
          <DialogDescription>
            النشاط يربط شريحة الاختيار في صفحة التسجيل بمجموعة افتراضية من صلاحيات القوائم.
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
              <Label className="flex items-center justify-between">
                <span>
                  صلاحيات القوائم المُفعَّلة لهذا النشاط
                  <span className="text-xs text-muted-foreground mr-2 font-normal">
                    (محدّد {editing.recommendedModuleKeys.length} من {MENU_ITEMS.length})
                  </span>
                </span>
                <span className="flex items-center gap-1">
                  <Button
                    type="button" size="sm" variant="ghost" className="h-7 text-xs"
                    onClick={() => setEditing({ ...editing, recommendedModuleKeys: MENU_ITEMS.map(m => m.key) })}
                  >
                    تحديد الكل
                  </Button>
                  <Button
                    type="button" size="sm" variant="ghost" className="h-7 text-xs"
                    onClick={() => setEditing({ ...editing, recommendedModuleKeys: [] })}
                  >
                    مسح
                  </Button>
                </span>
              </Label>

              <div className="relative">
                <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  dir="rtl" className="pr-9"
                  placeholder="بحث في الصلاحيات (مثال: تقارير، مخازن، POS)…"
                  value={pickerSearch}
                  onChange={(e) => setPickerSearch(e.target.value)}
                />
              </div>

              <div
                id="ind-perms-picker"
                className="border rounded-lg p-3 max-h-80 overflow-y-auto space-y-3"
              >
                {filteredGroups.length === 0 ? (
                  <div className="text-xs text-muted-foreground text-center py-6">
                    لا توجد نتائج مطابقة للبحث.
                  </div>
                ) : filteredGroups.map(({ section, items }) => {
                  const theme = SECTION_THEME[section];
                  const allKeys = MENU_ITEMS.filter(m => m.section === section).map(m => m.key);
                  const selectedInSection = allKeys.filter(k => editing.recommendedModuleKeys.includes(k)).length;
                  const allOn = selectedInSection === allKeys.length;
                  return (
                    <div key={section}>
                      <div className="flex items-center justify-between mb-1.5 px-1">
                        <button
                          type="button"
                          onClick={() => toggleSectionInForm(section)}
                          className={`text-[11px] font-semibold px-2 py-0.5 rounded inline-flex items-center gap-1 ${theme?.bg ?? ""} ${theme?.text ?? ""} ${theme?.border ?? ""} border hover:opacity-80 transition`}
                          title={allOn ? "إلغاء تحديد القسم" : "تحديد القسم بالكامل"}
                        >
                          {allOn ? <CheckSquare className="h-3 w-3" /> : <Square className="h-3 w-3" />}
                          {section}
                        </button>
                        <span className="text-[10px] text-muted-foreground">
                          {selectedInSection}/{allKeys.length}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {items.map(m => {
                          const checked = editing.recommendedModuleKeys.includes(m.key);
                          return (
                            <button
                              type="button"
                              key={m.key}
                              data-testid={`perm-pick-${m.key}`}
                              onClick={() => toggleMenuKeyInForm(m.key)}
                              className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs border-2 transition ${
                                checked
                                  ? "border-primary bg-primary/10 text-primary font-medium"
                                  : "border-border bg-card text-muted-foreground hover:border-primary/40"
                              }`}
                              title={m.key}
                            >
                              {checked && <Check className="h-3 w-3" />}
                              {m.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="text-[10px] text-muted-foreground">
                كل صلاحية محدَّدة هنا ستُفعَّل تلقائياً في «صلاحيات القوائم» للشركة الجديدة عند اختيار هذا النشاط في صفحة التسجيل.
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
