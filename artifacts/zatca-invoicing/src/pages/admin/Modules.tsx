import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
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
  Package, Users, Truck, Boxes, Store, Calculator, Wallet, UserCog,
  FileCheck, Layers, ShoppingCart, ClipboardList, BarChart3, Settings2,
  Pencil, Trash2, Plus, RefreshCw, Search, Sparkles, Power,
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

// Whitelisted icon set the operator can pick from. Keeping this curated (vs.
// "any lucide name") avoids dead/missing icons appearing on the registration
// screen if a typo slips into the DB.
const ICON_OPTIONS: Record<string, any> = {
  Package, Users, Truck, Boxes, Store, Calculator, Wallet, UserCog,
  FileCheck, Layers, ShoppingCart, ClipboardList, BarChart3, Settings2,
};

type ModuleRow = {
  id: number;
  key: string;
  nameAr: string;
  nameEn: string;
  description: string;
  monthlyPrice: string;
  icon: string;
  iconColor: string;
  category: string;
  sortOrder: number;
  isActive: boolean;
};

type FormState = Omit<ModuleRow, "id"> & { id?: number };

const EMPTY_FORM: FormState = {
  key: "",
  nameAr: "",
  nameEn: "",
  description: "",
  monthlyPrice: "0",
  icon: "Package",
  iconColor: "#0ea5e9",
  category: "",
  sortOrder: 0,
  isActive: true,
};

function IconBubble({ name, color, size = 20 }: { name: string; color: string; size?: number }) {
  const Cmp = ICON_OPTIONS[name] ?? Package;
  return (
    <div
      className="flex items-center justify-center rounded-lg"
      style={{
        width: size + 16, height: size + 16,
        background: `${color}1a`, // ~10% opacity
        color,
      }}
    >
      <Cmp size={size} />
    </div>
  );
}

export default function Modules() {
  const { token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<FormState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ModuleRow | null>(null);

  const listQ = useQuery<ModuleRow[]>({
    queryKey: ["admin-modules"],
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
    return list.filter(m =>
      m.nameAr.toLowerCase().includes(q) ||
      m.nameEn.toLowerCase().includes(q) ||
      m.key.toLowerCase().includes(q) ||
      m.category.toLowerCase().includes(q)
    );
  }, [listQ.data, search]);

  // Group by category for visual structure (matches the registration screen).
  const grouped = useMemo(() => {
    const map = new Map<string, ModuleRow[]>();
    for (const m of filtered) {
      const k = m.category || "بدون تصنيف";
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(m);
    }
    return Array.from(map.entries());
  }, [filtered]);

  const saveMut = useMutation({
    mutationFn: async (form: FormState) => {
      const isUpdate = typeof form.id === "number";
      const url = isUpdate ? `${API}/api/admin/modules/${form.id}` : `${API}/api/admin/modules`;
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
      qc.invalidateQueries({ queryKey: ["admin-modules"] });
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const toggleMut = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/admin/modules/${id}/toggle`, { method: "PATCH", headers });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "فشل التبديل");
      return d;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-modules"] }),
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/admin/modules/${id}`, { method: "DELETE", headers });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "فشل الحذف");
      return d;
    },
    onSuccess: () => {
      toast({ title: "تم الحذف" });
      setConfirmDelete(null);
      qc.invalidateQueries({ queryKey: ["admin-modules"] });
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const seedMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/admin/modules/seed`, { method: "POST", headers });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "فشل التهيئة");
      return d;
    },
    onSuccess: (d: any) => {
      toast({
        title: "اكتمل تحميل الوحدات الافتراضية",
        description: `أُضيف ${d.inserted} • تم تجاوز ${d.skipped}`,
      });
      qc.invalidateQueries({ queryKey: ["admin-modules"] });
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-6 p-4 md:p-6" dir="rtl">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Layers className="text-primary" /> إدارة وحدات النظام
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            أضف وعدّل وحذف الوحدات (Modules) التي تظهر في صفحة إنشاء الحساب وفي باقات الاشتراك.
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
              تحميل الوحدات الافتراضية
            </Button>
          )}
          <Button onClick={() => setEditing({ ...EMPTY_FORM })}>
            <Plus className="h-4 w-4 ml-2" />
            إضافة وحدة
          </Button>
        </div>
      </div>

      <div className="relative max-w-md">
        <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          dir="rtl" className="pr-9"
          placeholder="بحث بالاسم أو المُعرّف أو التصنيف…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {listQ.isLoading ? (
        <div className="text-center text-muted-foreground py-12">جاري التحميل…</div>
      ) : (listQ.data?.length ?? 0) === 0 ? (
        <Card>
          <CardContent className="py-16 text-center space-y-3">
            <Layers className="h-12 w-12 mx-auto text-muted-foreground/50" />
            <div className="text-lg font-medium">لا توجد وحدات بعد</div>
            <div className="text-sm text-muted-foreground">
              ابدأ بتحميل الوحدات الافتراضية أو أضف وحدة يدوياً.
            </div>
          </CardContent>
        </Card>
      ) : grouped.length === 0 ? (
        <div className="text-center text-muted-foreground py-12">لا نتائج مطابقة للبحث.</div>
      ) : (
        <div className="space-y-6">
          {grouped.map(([cat, items]) => (
            <div key={cat}>
              <div className="text-xs font-semibold text-muted-foreground mb-2 px-1">{cat}</div>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {items.map(m => (
                  <Card key={m.id} className={`relative transition ${m.isActive ? "" : "opacity-60"}`}>
                    <CardContent className="p-4 space-y-3">
                      <div className="flex items-start gap-3">
                        <IconBubble name={m.icon} color={m.iconColor} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <div className="font-semibold truncate">{m.nameAr}</div>
                            {!m.isActive && <Badge variant="outline" className="text-[10px]">مُعطَّلة</Badge>}
                          </div>
                          <div className="text-xs text-muted-foreground truncate">{m.key}</div>
                        </div>
                        <div className="text-left whitespace-nowrap">
                          <div className="text-primary font-bold">{Number(m.monthlyPrice).toFixed(0)} <span className="text-xs">ر.س</span></div>
                          <div className="text-[10px] text-muted-foreground">شهرياً</div>
                        </div>
                      </div>

                      {m.description && (
                        <p className="text-xs text-muted-foreground line-clamp-2">{m.description}</p>
                      )}

                      <div className="flex items-center justify-between gap-2 pt-2 border-t">
                        <div className="flex items-center gap-2 text-xs">
                          <Switch
                            checked={m.isActive}
                            onCheckedChange={() => toggleMut.mutate(m.id)}
                            disabled={toggleMut.isPending}
                          />
                          <Power className="h-3.5 w-3.5" />
                          {m.isActive ? "مفعّلة" : "متوقفة"}
                        </div>
                        <div className="flex items-center gap-1">
                          <Button size="sm" variant="ghost"
                            onClick={() => setEditing({ ...m })}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button size="sm" variant="ghost"
                            className="text-destructive hover:text-destructive"
                            onClick={() => setConfirmDelete(m)}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add / edit dialog */}
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-2xl" dir="rtl">
          <DialogHeader>
            <DialogTitle>
              {editing?.id ? "تعديل وحدة" : "إضافة وحدة جديدة"}
            </DialogTitle>
            <DialogDescription>
              أدخل بيانات الوحدة بشكل كامل. المُعرّف (key) يستخدم داخلياً لربط الوحدة بالكود.
            </DialogDescription>
          </DialogHeader>

          {editing && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>المُعرّف (key) *</Label>
                <Input
                  dir="ltr" placeholder="sales"
                  value={editing.key}
                  onChange={(e) => setEditing({ ...editing, key: e.target.value })}
                />
                <div className="text-[10px] text-muted-foreground">
                  أحرف إنجليزية صغيرة وأرقام و _ فقط.
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>السعر الشهري (ر.س)</Label>
                <Input
                  type="number" min={0} step="0.01"
                  value={editing.monthlyPrice}
                  onChange={(e) => setEditing({ ...editing, monthlyPrice: e.target.value })}
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
                <Label>الوصف</Label>
                <Textarea
                  rows={2}
                  value={editing.description}
                  onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                />
              </div>

              <div className="space-y-1.5">
                <Label>التصنيف</Label>
                <Input
                  placeholder="مثال: المبيعات والعملاء"
                  value={editing.category}
                  onChange={(e) => setEditing({ ...editing, category: e.target.value })}
                />
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
                <Label>الأيقونة</Label>
                <div className="grid grid-cols-7 gap-1.5 p-2 border rounded-lg max-h-32 overflow-y-auto">
                  {Object.keys(ICON_OPTIONS).map(name => {
                    const Cmp = ICON_OPTIONS[name];
                    const selected = editing.icon === name;
                    return (
                      <button
                        type="button"
                        key={name}
                        onClick={() => setEditing({ ...editing, icon: name })}
                        className={`p-2 rounded-md flex items-center justify-center transition ${
                          selected ? "ring-2 ring-primary bg-primary/10" : "hover:bg-muted"
                        }`}
                        title={name}
                      >
                        <Cmp className="h-4 w-4" style={{ color: editing.iconColor }} />
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>لون الأيقونة</Label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={editing.iconColor}
                    onChange={(e) => setEditing({ ...editing, iconColor: e.target.value })}
                    className="h-10 w-14 rounded border cursor-pointer"
                  />
                  <Input
                    dir="ltr"
                    value={editing.iconColor}
                    onChange={(e) => setEditing({ ...editing, iconColor: e.target.value })}
                  />
                  <IconBubble name={editing.icon} color={editing.iconColor} size={16} />
                </div>
              </div>

              <div className="md:col-span-2 flex items-center gap-3 pt-2 border-t">
                <Switch
                  checked={editing.isActive}
                  onCheckedChange={(v) => setEditing({ ...editing, isActive: v })}
                />
                <Label className="cursor-pointer" onClick={() => setEditing({ ...editing, isActive: !editing.isActive })}>
                  {editing.isActive ? "مفعّلة — تظهر في صفحة إنشاء الحساب" : "متوقفة — مخفية عن العملاء"}
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

      {/* Delete confirm */}
      <AlertDialog open={confirmDelete !== null} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>حذف الوحدة</AlertDialogTitle>
            <AlertDialogDescription>
              هل تريد حذف الوحدة <span className="font-bold">{confirmDelete?.nameAr}</span>؟
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
