import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import {
  Users as UsersIcon, Plus, Pencil, Trash2, Shield, Search, KeyRound,
  CheckCircle2, XCircle, Loader2, X, Save, Check,
} from "lucide-react";
import {
  PERMISSION_MODULES, PERMISSION_GROUPS, ACTION_LABELS,
  emptyPermissions, fullPermissions, viewOnlyPermissions,
  type PermissionMap, type Action,
} from "@/lib/permissions";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type UserRow = {
  id: number;
  username: string;
  email: string | null;
  role: string;
  code: string | null;
  nameAr: string | null;
  nameEn: string | null;
  permissions: PermissionMap | null;
  isActive: boolean;
  lastLoginAt: string | null;
  branchIds: number[];
};

type Branch = { id: number; code: string; nameAr: string; nameEn?: string | null };

const emptyForm = () => ({
  id: 0 as number,
  code: "",
  nameAr: "",
  nameEn: "",
  username: "",
  password: "",
  email: "",
  role: "user" as "user" | "admin",
  isActive: true,
  branchIds: [] as number[],
  permissions: viewOnlyPermissions(),
});

export default function Users() {
  const { user, token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const authH = { Authorization: `Bearer ${token}` };

  const [search, setSearch] = useState("");
  const [openForm, setOpenForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState(emptyForm());
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  const url   = cid ? `${API}/api/users?companyId=${cid}` : `${API}/api/users`;
  const burl  = cid ? `${API}/api/org/branches?companyId=${cid}` : `${API}/api/org/branches`;

  const { data: users = [], isLoading } = useQuery<UserRow[]>({
    queryKey: ["users", cid],
    queryFn: async () => {
      const r = await fetch(url, { headers: authH });
      if (!r.ok) return [];
      return r.json();
    },
  });

  const { data: branches = [] } = useQuery<Branch[]>({
    queryKey: ["branches-for-users", cid],
    queryFn: async () => {
      const r = await fetch(burl, { headers: authH });
      if (!r.ok) return [];
      const data = await r.json();
      if (Array.isArray(data)) return data;
      return Array.isArray(data?.branches) ? data.branches : [];
    },
  });

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return users;
    return users.filter(u =>
      (u.username ?? "").toLowerCase().includes(s) ||
      (u.nameAr ?? "").toLowerCase().includes(s) ||
      (u.nameEn ?? "").toLowerCase().includes(s) ||
      (u.code ?? "").toLowerCase().includes(s) ||
      (u.email ?? "").toLowerCase().includes(s),
    );
  }, [users, search]);

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm());
    setOpenForm(true);
    setConfirmDeleteId(null);
    setTimeout(() => {
      document.getElementById("user-form-card")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
  };

  const openEdit = (u: UserRow) => {
    setEditingId(u.id);
    setForm({
      id: u.id,
      code: u.code ?? "",
      nameAr: u.nameAr ?? "",
      nameEn: u.nameEn ?? "",
      username: u.username,
      password: "",
      email: u.email ?? "",
      role: (u.role === "admin" ? "admin" : "user"),
      isActive: u.isActive,
      branchIds: u.branchIds ?? [],
      permissions: { ...viewOnlyPermissions(), ...(u.permissions ?? {}) },
    });
    setOpenForm(true);
    setConfirmDeleteId(null);
    setTimeout(() => {
      document.getElementById("user-form-card")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
  };

  const closeForm = () => {
    setOpenForm(false);
    setEditingId(null);
    setForm(emptyForm());
  };

  const saveMut = useMutation({
    mutationFn: async () => {
      const body: any = {
        companyId: cid,
        code: form.code,
        nameAr: form.nameAr,
        nameEn: form.nameEn,
        email: form.email,
        role: form.role,
        isActive: form.isActive,
        branchIds: form.branchIds,
        permissions: form.permissions,
      };
      if (editingId == null) {
        body.username = form.username;
        body.password = form.password;
        const r = await fetch(`${API}/api/users?companyId=${cid ?? ""}`, {
          method: "POST",
          headers: { ...authH, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data?.error || "فشل الحفظ");
        return data;
      } else {
        if (form.password) body.password = form.password;
        const r = await fetch(`${API}/api/users/${editingId}?companyId=${cid ?? ""}`, {
          method: "PATCH",
          headers: { ...authH, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data?.error || "فشل التحديث");
        return data;
      }
    },
    onSuccess: () => {
      toast({ title: "تم الحفظ", description: editingId == null ? "تم إضافة المستخدم" : "تم تحديث المستخدم" });
      qc.invalidateQueries({ queryKey: ["users", cid] });
      closeForm();
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/users/${id}?companyId=${cid ?? ""}`, {
        method: "DELETE",
        headers: authH,
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data?.error || "فشل الحذف");
    },
    onSuccess: () => {
      toast({ title: "تم الحذف" });
      qc.invalidateQueries({ queryKey: ["users", cid] });
      setConfirmDeleteId(null);
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const togglePerm = (modKey: string, action: Action, val: boolean) => {
    setForm(f => ({
      ...f,
      permissions: {
        ...f.permissions,
        [modKey]: { ...(f.permissions[modKey] ?? {}), [action]: val },
      },
    }));
  };

  const setGroupAll = (group: string, val: boolean) => {
    setForm(f => {
      const next = { ...f.permissions };
      PERMISSION_MODULES.filter(m => m.group === group).forEach(m => {
        next[m.key] = {};
        m.actions.forEach(a => { next[m.key][a] = val; });
      });
      return { ...f, permissions: next };
    });
  };

  const applyPreset = (preset: "full" | "view" | "none") => {
    const p = preset === "full" ? fullPermissions() : preset === "view" ? viewOnlyPermissions() : emptyPermissions();
    setForm(f => ({ ...f, permissions: p }));
  };

  return (
    <div className="p-6 space-y-6" dir="rtl">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="p-3 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-600 text-white">
            <UsersIcon className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">المستخدمون</h1>
            <p className="text-sm text-muted-foreground">
              إضافة وتعديل المستخدمين وتحديد صلاحياتهم وفروعهم
            </p>
          </div>
        </div>
        {!openForm && (
          <Button onClick={openCreate} className="gap-2 bg-gradient-to-l from-cyan-600 to-blue-600 hover:from-cyan-700 hover:to-blue-700">
            <Plus className="h-4 w-4" />
            إضافة مستخدم جديد
          </Button>
        )}
      </div>

      {/* ─── Inline Form (replaces popup) ─────────────────── */}
      {openForm && (
        <Card id="user-form-card" className="border-2 border-blue-200 dark:border-blue-900 shadow-lg">
          <CardHeader className="bg-gradient-to-l from-blue-50 to-cyan-50 dark:from-blue-950/40 dark:to-cyan-950/40 border-b">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <CardTitle className="flex items-center gap-2 text-lg">
                {editingId == null ? <Plus className="h-5 w-5 text-blue-600" /> : <Pencil className="h-5 w-5 text-blue-600" />}
                {editingId == null ? "إضافة مستخدم جديد" : `تعديل: ${form.nameAr || form.username}`}
              </CardTitle>
              <div className="flex gap-2">
                <Button variant="outline" onClick={closeForm} className="gap-1">
                  <X className="h-4 w-4" /> إلغاء
                </Button>
                <Button
                  onClick={() => saveMut.mutate()}
                  disabled={
                    saveMut.isPending ||
                    !form.username ||
                    (editingId == null && !form.password)
                  }
                  className="bg-blue-600 hover:bg-blue-700 gap-1"
                >
                  {saveMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  {editingId == null ? "إنشاء المستخدم" : "حفظ التعديلات"}
                </Button>
              </div>
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              املأ البيانات الأساسية، اختر الفروع، وحدّد الصلاحيات لكل شاشة.
            </p>
          </CardHeader>

          <CardContent className="pt-5">
            <Tabs defaultValue="info" className="w-full">
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="info">البيانات الأساسية</TabsTrigger>
                <TabsTrigger value="branches">الفروع ({form.branchIds.length})</TabsTrigger>
                <TabsTrigger value="permissions">الصلاحيات</TabsTrigger>
              </TabsList>

              {/* ─── Info Tab ───────────────────────────── */}
              <TabsContent value="info" className="space-y-4 pt-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <Label>الكود</Label>
                    <Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="EMP-001" />
                  </div>
                  <div>
                    <Label>الاسم بالعربية</Label>
                    <Input value={form.nameAr} onChange={(e) => setForm({ ...form, nameAr: e.target.value })} placeholder="محمد أحمد" />
                  </div>
                  <div>
                    <Label>English Name</Label>
                    <Input value={form.nameEn} onChange={(e) => setForm({ ...form, nameEn: e.target.value })} placeholder="Mohamed Ahmed" />
                  </div>
                  <div>
                    <Label>اسم المستخدم *</Label>
                    <Input
                      value={form.username}
                      onChange={(e) => setForm({ ...form, username: e.target.value })}
                      placeholder="username"
                      disabled={editingId != null}
                      className="font-mono"
                    />
                  </div>
                  <div>
                    <Label>البريد الإلكتروني</Label>
                    <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="user@company.com" />
                  </div>
                  <div>
                    <Label className="flex items-center gap-1">
                      <KeyRound className="h-3 w-3" />
                      {editingId == null ? "كلمة المرور *" : "كلمة مرور جديدة (اختياري)"}
                    </Label>
                    <Input
                      type="password"
                      value={form.password}
                      onChange={(e) => setForm({ ...form, password: e.target.value })}
                      placeholder={editingId == null ? "6 أحرف على الأقل" : "اتركها فارغة لعدم التغيير"}
                      autoComplete="new-password"
                    />
                  </div>
                  <div>
                    <Label>الدور</Label>
                    <select
                      value={form.role}
                      onChange={(e) => setForm({ ...form, role: e.target.value as any })}
                      className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
                    >
                      <option value="user">مستخدم (يستخدم الصلاحيات أدناه)</option>
                      <option value="admin">مدير الشركة (صلاحيات كاملة)</option>
                    </select>
                  </div>
                  <div className="flex items-end gap-3 pb-2">
                    <Switch checked={form.isActive} onCheckedChange={(v) => setForm({ ...form, isActive: v })} />
                    <Label>الحساب نشط</Label>
                  </div>
                </div>
              </TabsContent>

              {/* ─── Branches Tab ───────────────────────── */}
              <TabsContent value="branches" className="space-y-3 pt-4">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="text-sm text-muted-foreground">
                    حدّد الفروع التي يستطيع المستخدم الوصول إليها. اتركها فارغة للسماح بكل الفروع.
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => setForm({ ...form, branchIds: branches.map(b => b.id) })}>
                      تحديد الكل
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setForm({ ...form, branchIds: [] })}>
                      مسح الكل
                    </Button>
                  </div>
                </div>
                {branches.length === 0 ? (
                  <div className="text-center py-12 text-muted-foreground border rounded-lg">
                    لا توجد فروع. أضف فروعاً من شاشة "الفروع" أولاً.
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                    {branches.map(b => {
                      const checked = form.branchIds.includes(b.id);
                      return (
                        <label
                          key={b.id}
                          className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition ${
                            checked ? "bg-blue-50 border-blue-300 dark:bg-blue-950/30" : "hover:bg-muted/50"
                          }`}
                        >
                          <Checkbox
                            checked={checked}
                            onCheckedChange={(v) => {
                              setForm(f => ({
                                ...f,
                                branchIds: v
                                  ? [...f.branchIds, b.id]
                                  : f.branchIds.filter(id => id !== b.id),
                              }));
                            }}
                          />
                          <div>
                            <div className="font-mono text-xs text-muted-foreground">{b.code}</div>
                            <div className="font-medium">{b.nameAr}</div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                )}
              </TabsContent>

              {/* ─── Permissions Tab ────────────────────── */}
              <TabsContent value="permissions" className="space-y-4 pt-4">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="text-sm text-muted-foreground flex items-center gap-2">
                    <Shield className="h-4 w-4 text-indigo-600" />
                    حدّد ما يستطيع المستخدم فعله في كل شاشة.
                    {form.role === "admin" && <span className="text-amber-600 font-semibold">(دور المدير: كل الصلاحيات تلقائياً)</span>}
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => applyPreset("full")}>كل الصلاحيات</Button>
                    <Button size="sm" variant="outline" onClick={() => applyPreset("view")}>عرض فقط</Button>
                    <Button size="sm" variant="outline" onClick={() => applyPreset("none")}>لا شيء</Button>
                  </div>
                </div>

                <div className={`space-y-4 ${form.role === "admin" ? "opacity-50 pointer-events-none" : ""}`}>
                  {PERMISSION_GROUPS.map(group => {
                    const mods = PERMISSION_MODULES.filter(m => m.group === group);
                    return (
                      <div key={group} className="border rounded-lg overflow-hidden">
                        <div className="bg-muted/50 px-4 py-2 flex items-center justify-between">
                          <div className="font-semibold text-sm">{group}</div>
                          <div className="flex gap-1">
                            <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => setGroupAll(group, true)}>تفعيل</Button>
                            <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => setGroupAll(group, false)}>تعطيل</Button>
                          </div>
                        </div>
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b">
                              <th className="text-right p-2 font-medium">الشاشة</th>
                              {(["view", "create", "edit", "delete", "post", "export"] as Action[]).map(a => (
                                <th key={a} className="p-2 font-medium w-16 text-center">{ACTION_LABELS[a]}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {mods.map(m => (
                              <tr key={m.key} className="border-b last:border-b-0 hover:bg-muted/30">
                                <td className="p-2">{m.label}</td>
                                {(["view", "create", "edit", "delete", "post", "export"] as Action[]).map(a => {
                                  const supported = m.actions.includes(a);
                                  const checked = !!form.permissions[m.key]?.[a];
                                  return (
                                    <td key={a} className="p-2 text-center">
                                      {supported ? (
                                        <Checkbox checked={checked} onCheckedChange={(v) => togglePerm(m.key, a, !!v)} />
                                      ) : (
                                        <span className="text-muted-foreground/40">—</span>
                                      )}
                                    </td>
                                  );
                                })}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    );
                  })}
                </div>
              </TabsContent>
            </Tabs>

            {/* Bottom action bar (mirror) */}
            <div className="flex justify-end gap-2 pt-5 mt-4 border-t">
              <Button variant="outline" onClick={closeForm} className="gap-1">
                <X className="h-4 w-4" /> إلغاء
              </Button>
              <Button
                onClick={() => saveMut.mutate()}
                disabled={
                  saveMut.isPending ||
                  !form.username ||
                  (editingId == null && !form.password)
                }
                className="bg-blue-600 hover:bg-blue-700 gap-1"
              >
                {saveMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                {editingId == null ? "إنشاء المستخدم" : "حفظ التعديلات"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Search */}
      <Card>
        <CardContent className="pt-5">
          <div className="relative">
            <Search className="h-4 w-4 absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="بحث بالكود، الاسم، اسم المستخدم، البريد..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pr-9"
            />
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">قائمة المستخدمين ({filtered.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-center py-12 text-muted-foreground">
              <Loader2 className="h-6 w-6 inline-block animate-spin ml-2" /> جاري التحميل...
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <UsersIcon className="h-10 w-10 mx-auto mb-2 opacity-30" />
              لا يوجد مستخدمون. اضغط "إضافة مستخدم جديد" لإنشاء واحد.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-right">الكود</TableHead>
                    <TableHead className="text-right">الاسم بالعربية</TableHead>
                    <TableHead className="text-right">English Name</TableHead>
                    <TableHead className="text-right">اسم المستخدم</TableHead>
                    <TableHead className="text-right">البريد</TableHead>
                    <TableHead className="text-right">الدور</TableHead>
                    <TableHead className="text-right">الفروع</TableHead>
                    <TableHead className="text-right">الحالة</TableHead>
                    <TableHead className="text-right">إجراءات</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map(u => {
                    const branchNames = branches.filter(b => u.branchIds?.includes(b.id)).map(b => b.nameAr);
                    const isConfirming = confirmDeleteId === u.id;
                    return (
                      <TableRow key={u.id} className={isConfirming ? "bg-red-50/60 dark:bg-red-950/20" : ""}>
                        <TableCell className="font-mono">{u.code || "—"}</TableCell>
                        <TableCell>{u.nameAr || "—"}</TableCell>
                        <TableCell className="text-muted-foreground">{u.nameEn || "—"}</TableCell>
                        <TableCell className="font-mono">{u.username}</TableCell>
                        <TableCell className="text-xs">{u.email || "—"}</TableCell>
                        <TableCell>
                          {u.role === "superadmin" && <Badge className="bg-purple-600">مدير النظام</Badge>}
                          {u.role === "admin" && <Badge className="bg-blue-600">مدير الشركة</Badge>}
                          {u.role === "user" && <Badge variant="outline">مستخدم</Badge>}
                        </TableCell>
                        <TableCell className="text-xs">
                          {branchNames.length === 0 ? (
                            <span className="text-muted-foreground">— الكل —</span>
                          ) : (
                            <span className="line-clamp-1">{branchNames.join("، ")}</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {u.isActive ? (
                            <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-300 gap-1">
                              <CheckCircle2 className="h-3 w-3" /> نشط
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="bg-red-50 text-red-700 border-red-300 gap-1">
                              <XCircle className="h-3 w-3" /> موقوف
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          {isConfirming ? (
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-red-700 font-semibold">تأكيد الحذف؟</span>
                              <Button
                                size="sm"
                                variant="destructive"
                                onClick={() => deleteMut.mutate(u.id)}
                                disabled={deleteMut.isPending}
                                className="h-7 px-2"
                              >
                                {deleteMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setConfirmDeleteId(null)}
                                className="h-7 px-2"
                              >
                                <X className="h-3 w-3" />
                              </Button>
                            </div>
                          ) : (
                            <div className="flex gap-1">
                              <Button size="sm" variant="ghost" onClick={() => openEdit(u)} title="تعديل">
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-red-600 hover:text-red-700 hover:bg-red-50"
                                onClick={() => setConfirmDeleteId(u.id)}
                                title="حذف"
                                disabled={u.role === "superadmin" || u.id === user?.id}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
